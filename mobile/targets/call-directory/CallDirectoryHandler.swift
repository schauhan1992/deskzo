import CallKit
import Foundation

/**
 * Deskzo's caller ID on an iPhone (owner, 22 Oct 2026): iOS's Call Directory extension. iOS runs it when the app
 * asks (modules/deskzo-ios, after it writes the list) and shows its label while a number on it rings — the customer's
 * name and company, for the customers the person may see in Deskzo (/api/app/calls/directory on the server).
 *
 * The list is the app's, in the App Group they share (group.<the app's bundle id>, from app.config.ts): E.164 digits,
 * ascending, each once (src/lib/phone-numbers.ts).
 * It is read again in full every time — iOS is told to drop what it had — and anything out of order is skipped rather
 * than failing the whole list. Nothing is ever blocked: identification only.
 */
final class CallDirectoryHandler: CXCallDirectoryProvider {
  override func beginRequest(with context: CXCallDirectoryExtensionContext) {
    context.delegate = self
    if context.isIncremental {
      context.removeAllIdentificationEntries()
    }
    var last: CXCallDirectoryPhoneNumber = 0
    for entry in Self.entries() {
      guard entry.number > last else { continue }
      context.addIdentificationEntry(withNextSequentialPhoneNumber: entry.number, label: entry.label)
      last = entry.number
    }
    context.completeRequest()
  }

  /// The app's App Group: this extension is <app>.CallDirectory, and the group is group.<app>.
  private static func appGroup() -> String? {
    guard let id = Bundle.main.bundleIdentifier, let dot = id.lastIndex(of: ".") else { return nil }
    return "group.\(id[..<dot])"
  }

  private static func entries() -> [(number: CXCallDirectoryPhoneNumber, label: String)] {
    guard
      let group = appGroup(),
      let file = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("caller-ids.json"),
      let data = try? Data(contentsOf: file),
      let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]]
    else {
      return []
    }
    return rows.compactMap { row in
      guard let digits = row["n"], let number = CXCallDirectoryPhoneNumber(digits), let label = row["l"], !label.isEmpty else { return nil }
      return (number, label)
    }
  }
}

extension CallDirectoryHandler: CXCallDirectoryExtensionContextDelegate {
  func requestFailed(for extensionContext: CXCallDirectoryExtensionContext, withError error: Error) {
    // The app hears of it from reloadExtension's answer, and says so in Settings.
  }
}
