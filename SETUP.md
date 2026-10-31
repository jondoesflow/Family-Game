# Getting Zing onto your phone via TestFlight (no laptop needed)

Everything below is done on your iPhone in Safari, plus the free **TestFlight** app.
The build itself runs on a Mac in the cloud (GitHub Actions). You never touch Xcode.

Total time: about 30 minutes of tapping, then 15 to 25 minutes of waiting for Apple.

---

## What you need first

1. **Apple Developer Program** membership (£79 a year). Enrol in the **Apple Developer** app
   on your iPhone (App Store, search "Apple Developer", then Account, then Enrol Now).
   Approval can take up to 48 hours.
2. **TestFlight** app installed from the App Store.
3. This repository on GitHub with the code on the `main` branch (already done if you are reading this there).

---

## Step 1: Your Team ID

1. In Safari go to **https://developer.apple.com/account**.
2. Scroll to **Membership details**. Copy the 10 character **Team ID** (looks like `AB12CD34EF`).

Keep it in Notes for a minute. You will paste it into GitHub as `APPLE_TEAM_ID`.

---

## Step 2: Create an App Store Connect API key

1. Go to **https://appstoreconnect.apple.com/access/integrations/api**
   (Users and Access, then Integrations, then App Store Connect API, then Team Keys).
2. If asked, tap **Request Access** and accept.
3. Tap **+** (Generate API Key). Name: `Zing CI`. Access: **Admin**. Tap Generate.
4. On the new row copy the **Key ID** (10 characters) and, at the top of the page, the **Issuer ID**
   (long UUID). Save both in Notes.
5. Tap **Download API Key**. Safari saves `AuthKey_XXXXXXXXXX.p8` to the Files app. **You can only download it once.**

### Reading the .p8 file on an iPhone

The file is plain text but Files will not preview it until it is renamed:

1. Open **Files**, go to **Downloads** (or iCloud Drive, Downloads).
2. Long press the `AuthKey_....p8` file, tap **Rename**, change the ending from `.p8` to `.txt`, tap Done (confirm "Use .txt").
3. Tap the file to open it. Tap and hold the text, **Select All**, **Copy**.
   It starts with `-----BEGIN PRIVATE KEY-----` and ends with `-----END PRIVATE KEY-----`.

You will paste that whole text into GitHub as `APP_STORE_CONNECT_KEY_CONTENT`.

---

## Step 3: Add the five secrets to GitHub

1. In Safari open your repo on **github.com**, tap the **Settings** tab (you may need to tap the
   "..." or scroll the tab bar), then **Secrets and variables**, then **Actions**.
   Direct link: `https://github.com/<you>/<repo>/settings/secrets/actions`
2. Tap **New repository secret** five times, one per row:

| Name | Value |
|---|---|
| `APPLE_TEAM_ID` | Team ID from Step 1 |
| `APP_STORE_CONNECT_KEY_ID` | Key ID from Step 2 |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID from Step 2 |
| `APP_STORE_CONNECT_KEY_CONTENT` | The whole text of the .p8 file |
| `MATCH_PASSWORD` | Any password you invent (e.g. three random words). Save it in Notes. |

`MATCH_PASSWORD` encrypts the signing certificate that gets stored on a `certificates` branch of this repo.

Optional: under the **Variables** tab add `BUNDLE_ID` if you want something other than the
default `com.jonrussell.zing`. The bundle ID is permanent once an app is created with it.

---

## Step 4: Run the workflow once (it registers the app ID for you)

1. Tap the **Actions** tab on the repo, choose **Build and ship to TestFlight** on the left, tap **Run workflow**, then the green **Run workflow** button.
2. The first run will register the bundle ID with Apple, then **stop on purpose** with a message telling you to create the app record (Apple does not let scripts do that part). That is expected.

---

## Step 5: Create the app record in App Store Connect

1. Go to **https://appstoreconnect.apple.com/apps**, tap **+**, **New App**.
2. Platform **iOS**. Name **Zing Quiz** (if taken, add your surname). Primary language **English (UK)**.
   Bundle ID: pick **com.jonrussell.zing** (or your custom one) from the list.
   SKU: `zing-quiz-1`. User access: Full. Tap **Create**.

---

## Step 6: Run the workflow again

Actions, Build and ship to TestFlight, Run workflow. This time it builds, signs and uploads.
Takes about 12 to 18 minutes. A green tick means Apple has the build.

---

## Step 7: Install from TestFlight

1. In App Store Connect open the app, tap **TestFlight**. After 10 to 20 minutes of processing the build appears.
2. Under **Internal Testing** tap **+** to create a group (name it "Family"), tick **Enable automatic distribution**, add yourself (and anyone else with an App Store Connect account).
   For family members without accounts, use **External Testing**: create a group, add the build, enable a **Public Link**, and send the link. The first external build needs a short Apple review (usually under a day).
3. Open the **TestFlight** app on your phone. Zing appears. Tap **Install**.

Every time code is pushed to `main`, or you tap Run workflow, a new build goes to TestFlight automatically. TestFlight builds expire after 90 days; just run the workflow again.

---

## If something goes wrong

* **"Missing GitHub secret(s)"**: a secret name is misspelt. Names are case sensitive.
* **"APP_STORE_CONNECT_KEY_CONTENT must be the full text of the .p8 file"**: paste the whole file including the BEGIN and END lines.
* **"App record missing in App Store Connect"**: do Step 5, then re-run.
* **"Could not find App with Bundle ID"** during upload: the bundle ID in App Store Connect does not match the `BUNDLE_ID` variable. Fix the variable to match.
* **Certificate errors mentioning "maximum number of certificates"**: go to https://developer.apple.com/account/resources/certificates, revoke old **Distribution** certificates you do not need, delete the `certificates` branch on GitHub, re-run.
* **Build appears in App Store Connect but not TestFlight**: wait; processing can take 30 minutes the first time. If it says "Missing Compliance", the Info.plist already declares no encryption, so this should not happen; if it does, tap Manage and choose "None of the algorithms".

The run logs are under the Actions tab; the step named **Build and upload to TestFlight** has the detail.
