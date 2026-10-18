# Releasing the Deskzo app on Google Play

## Once: the upload key (on your own computer — never in the repository)

Google Play signs the app people download with its own key ("Play App Signing"); you sign what you upload
with an **upload key**. Make it once, and keep the file and both passwords in your password manager — a lost
upload key can be reset through Play support, but it takes days.

```
"%LOCALAPPDATA%\Programs\jdk-17\bin\keytool.exe" -genkeypair -v -storetype PKCS12 -keystore "%USERPROFILE%\.deskzo\upload-key.jks" -alias deskzo-upload -keyalg RSA -keysize 2048 -validity 10000
```

(Create the `%USERPROFILE%\.deskzo` folder first. keytool asks for a password and your name; use the company's
name for "organization".)

Then tell the build where it is — in `%USERPROFILE%\.gradle\gradle.properties` (create it if missing):

```
DESKZO_UPLOAD_STORE_FILE=C:/Users/<you>/.deskzo/upload-key.jks
DESKZO_UPLOAD_STORE_PASSWORD=<the keystore password>
DESKZO_UPLOAD_KEY_ALIAS=deskzo-upload
DESKZO_UPLOAD_KEY_PASSWORD=<the key password — the same, unless you gave it another>
```

## Each release

1. Raise the version in `app.config.ts`: `version` (what people see, e.g. 0.2.0) and `android.versionCode`
   (a whole number, one more than the last upload — Google refuses a number it has seen).
2. If the app now does something new with people's data (push, recordings…), update the privacy page
   (deskzo.com/privacy/app — the CMS page, or `APP_PRIVACY` in src/components/site/defaults.ts),
   `data-safety.md` and Play's Data safety form **first**.
3. `node scripts/android.js release` — makes the bundle and an APK, and stops if the release asks for a
   permission the store isn't told about or allows plain HTTP. It says whether it was signed with the upload
   key; a build signed with the debug key is only for testing.
4. Install `app-release.apk` on a phone and try it against the live site: pair, a call with a customer, the
   after-call card, "Ring my phone".
5. In Play Console, upload `app-release.aab` to **Internal testing** first; add the testers' Google accounts;
   then promote to Production once they've used it.

## First release only — Play Console

- Create the app: name **Deskzo**, app (not game), free, the declarations.
- **Store listing** — text and graphics from `listing.md` and `graphics/`.
- **App content**:
  - Privacy policy: `https://deskzo.com/privacy/app`
  - App access — `review-access.md` (make the demo workspace and reviewer account first)
  - Ads: none · Content rating: the questionnaire in `listing.md` · Target audience: 18+
  - Data safety — `data-safety.md`
  - Sensitive app permissions › Call log — `permissions-declaration.md`, with the demo video
- **Production countries**: India first, or wherever your customers are.

Google's review of an app that reads the call log usually takes several days, and can ask for changes.
