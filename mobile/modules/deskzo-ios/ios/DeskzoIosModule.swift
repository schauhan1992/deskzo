import CallKit
import ExpoModulesCore
import UIKit
import WebKit

/**
 * The Deskzo app's iPhone side, for its JavaScript (src/lib/native.ios.ts) — what iOS allows in place of Android's
 * calling module (modules/deskzo-calls):
 *
 *   · Caller ID through CallKit's Call Directory: the app writes the customers' numbers to the App Group it shares
 *     with its extension (plugins/call-directory), then asks iOS to load them. iOS shows the name while they ring —
 *     once the person allows Deskzo in Settings › Phone › Call Blocking & Identification.
 *   · Signing out leaves nothing of Deskzo behind: the in-app pages' cookies and storage go with the token.
 *   · A screenshot taken in the app is reported, for the workspace's screenshot allowance. iOS says that one was
 *     taken — never what is in it — and, unlike Android, lets no app block them.
 *   · A fresh install, told apart from a reopening: the Keychain (where the phone's token is) outlives an uninstall,
 *     the app's own defaults don't — so a reinstalled app starts signed out, as on Android.
 */
public class DeskzoIosModule: Module {
  private var screenshots: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("DeskzoIos")

    Events("onScreenshot")

    OnStartObserving {
      self.screenshots = NotificationCenter.default.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onScreenshot", [:])
      }
    }

    OnStopObserving {
      if let observer = self.screenshots {
        NotificationCenter.default.removeObserver(observer)
      }
      self.screenshots = nil
    }

    Function("takeFreshInstall") { () -> Bool in
      let key = "deskzo.installed"
      if UserDefaults.standard.bool(forKey: key) {
        return false
      }
      UserDefaults.standard.set(true, forKey: key)
      return true
    }

    AsyncFunction("clearWebData") { (promise: Promise) in
      DispatchQueue.main.async {
        HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        let store = WKWebsiteDataStore.default()
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
          promise.resolve(nil)
        }
      }
    }

    /// A file a Deskzo page offered for download (react-native-webview's onFileDownload): fetched as the page, with
    /// its own cookies — the in-app pages' sign-in isn't Safari's — then handed to the share sheet, to save to Files or
    /// open in another app. False when it couldn't be fetched, or the person closed the sheet.
    AsyncFunction("saveDownload") { (address: String, promise: Promise) in
      guard let url = URL(string: address), url.scheme == "https" || url.scheme == "http" else {
        promise.resolve(false)
        return
      }
      // WebKit's store is only ever touched on the main thread; the download itself goes off it.
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
          Self.download(url, cookies: cookies.filter { Self.cookie($0, isFor: url) }) { file in
            guard let file else {
              promise.resolve(false)
              return
            }
            self.share(file, promise: promise)
          }
        }
      }
    }

    /// A file a page made itself (an export — src/lib/web-downloads.ts), its bytes in base64: to the share sheet.
    AsyncFunction("shareFile") { (name: String, base64: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64) else {
        promise.resolve(false)
        return
      }
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let safe = name.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
      let file = folder.appendingPathComponent(safe.isEmpty ? "download" : safe)
      do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
      } catch {
        promise.resolve(false)
        return
      }
      self.share(file, promise: promise)
    }

    // MARK: - Caller ID

    /// Writes the numbers for the extension, as given: E.164 digits, ascending, each once (src/lib/phone-numbers.ts).
    AsyncFunction("setCallerIds") { (entries: [CallerId]) throws -> Int in
      guard let file = Self.callerIdFile() else {
        throw NoAppGroupException()
      }
      let rows = entries.map { ["n": $0.number, "l": $0.label] }
      let data = try JSONSerialization.data(withJSONObject: rows)
      // Readable by the extension once the phone has been unlocked after starting — when iOS may load it.
      try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      return rows.count
    }

    /// Asks iOS to load the extension again with what was last written. Null, or why it didn't.
    AsyncFunction("reloadCallDirectory") { (promise: Promise) in
      CXCallDirectoryManager.sharedInstance.reloadExtension(withIdentifier: Self.extensionId()) { error in
        promise.resolve(error.map(Self.describe))
      }
    }

    /// Whether the person has switched Deskzo on in Settings › Phone › Call Blocking & Identification.
    AsyncFunction("callDirectoryStatus") { (promise: Promise) in
      CXCallDirectoryManager.sharedInstance.getEnabledStatusForExtension(withIdentifier: Self.extensionId()) { status, error in
        if error != nil {
          promise.resolve("unknown")
          return
        }
        switch status {
        case .enabled: promise.resolve("enabled")
        case .disabled: promise.resolve("disabled")
        default: promise.resolve("unknown")
        }
      }
    }

    /// Opens the Settings page where caller ID apps are switched on.
    AsyncFunction("openCallDirectorySettings") { (promise: Promise) in
      CXCallDirectoryManager.sharedInstance.openSettings { error in
        promise.resolve(error == nil)
      }
    }
  }

  /// The App Group and the extension, as plugins/call-directory wrote them into the app's Info.plist.
  private static func appGroup() -> String {
    Bundle.main.object(forInfoDictionaryKey: "DeskzoAppGroup") as? String ?? "group.\(Bundle.main.bundleIdentifier ?? "com.deskzo.app")"
  }

  private static func extensionId() -> String {
    Bundle.main.object(forInfoDictionaryKey: "DeskzoCallDirectory") as? String ?? "\(Bundle.main.bundleIdentifier ?? "com.deskzo.app").CallDirectory"
  }

  private static func callerIdFile() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup())?.appendingPathComponent("caller-ids.json")
  }

  /// Fetches the file as the page would, into a folder of its own named as the server names it. Nil when it can't.
  private static func download(_ url: URL, cookies: [HTTPCookie], done: @escaping (URL?) -> Void) {
    var request = URLRequest(url: url)
    HTTPCookie.requestHeaderFields(with: cookies).forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    URLSession(configuration: .ephemeral).downloadTask(with: request) { location, response, _ in
      guard let location, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        done(nil)
        return
      }
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let file = folder.appendingPathComponent(fileName(response: http, url: url))
      do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: location, to: file)
        done(file)
      } catch {
        done(nil)
      }
    }.resume()
  }

  /// The share sheet for a downloaded file: Save to Files, or another app. The file goes once the sheet closes.
  private func share(_ file: URL, promise: Promise) {
    DispatchQueue.main.async {
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(false)
        return
      }
      let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      // Saving to Photos would need a permission the app never asks for: Files has it instead.
      sheet.excludedActivityTypes = [.saveToCameraRoll, .assignToContact]
      // An iPad shows it as a popover, which needs somewhere to point from.
      sheet.popoverPresentationController?.sourceView = presenter.view
      sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
      sheet.popoverPresentationController?.permittedArrowDirections = []
      sheet.completionWithItemsHandler = { _, completed, _, _ in
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        promise.resolve(completed)
      }
      presenter.present(sheet, animated: true)
    }
  }

  /// The cookies a browser would send to this address: its host or a parent domain, its path, https-only ones on https.
  private static func cookie(_ cookie: HTTPCookie, isFor url: URL) -> Bool {
    guard let host = url.host?.lowercased() else { return false }
    let domain = cookie.domain.lowercased()
    let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
    let hostMatches = host == bare || host.hasSuffix("." + bare)
    let pathMatches = url.path.isEmpty || url.path.hasPrefix(cookie.path)
    return hostMatches && pathMatches && (!cookie.isSecure || url.scheme == "https")
  }

  /// The file's own name, as the server gives it (Content-Disposition), else the address's last part.
  private static func fileName(response: HTTPURLResponse, url: URL) -> String {
    let suggested = response.suggestedFilename ?? url.lastPathComponent
    let safe = suggested.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
    return safe.isEmpty ? "download" : safe
  }

  private static func describe(_ error: Error) -> String {
    let nsError = error as NSError
    guard nsError.domain == CXErrorDomainCallDirectoryManager, let code = CXErrorCodeCallDirectoryManagerError.Code(rawValue: nsError.code) else {
      return "unknown"
    }
    switch code {
    case .noExtensionFound: return "no_extension"
    case .loadingInterrupted: return "interrupted"
    case .entriesOutOfOrder: return "out_of_order"
    case .duplicateEntries: return "duplicates"
    case .maximumEntriesExceeded: return "too_many"
    case .extensionDisabled: return "disabled"
    case .currentlyLoading: return "busy"
    case .unexpectedIncrementalRemoval: return "incremental"
    default: return "unknown"
    }
  }
}

struct CallerId: Record {
  @Field var number: String = ""
  @Field var label: String = ""
}

final class NoAppGroupException: Exception {
  override var reason: String {
    "The app's App Group isn't set up, so caller ID can't be shared with its extension"
  }
}
