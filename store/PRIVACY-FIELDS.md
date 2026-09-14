# Chrome Web Store privacy fields — 1.0.2

Upload `dist/dear-customer-1.0.2.zip` to the existing item first. Version 1.0.2 removes redundant `activeTab`; WhatsApp host access already allows checking that tab's URL and running the bundled integration. The activeTab justification field should disappear after the package is processed.

## Single purpose description

Help users identify and manage unwanted promotional messages on WhatsApp Web by reviewing business senders and choosing to opt out, send STOP, report, block or archive selected chats.

## storage justification

Stores settings, ignored senders, sender names and phone numbers, first-seen times and action history locally so users can track repeat senders and keep their choices between sessions. Also stores a cached public spam list and a random installation identifier used to deduplicate optional Wall of Shame contributions. This data uses chrome.storage.local, not Chrome Sync.

## scripting justification

Injects the locally bundled vendor/wppconnect-wa.js library into WhatsApp Web after its chat interface has loaded. This lets the extension read chat and sender information and perform the actions the user selects through their existing WhatsApp Web session. Delayed injection is needed because WhatsApp's required modules are unavailable before login. No scripts are downloaded from a server.

## Host permissions justification

https://web.whatsapp.com/*: Runs the extension inside WhatsApp Web to identify promotional senders, display the review panel and perform user-selected opt-out, STOP, report, block and archive actions.

https://dearcustomer.kanishkdan.com/*: Fetches and caches the public spam list. When the user submits to the Wall of Shame, or leaves automatic contribution on (a clearly labelled option on the mandatory setup screen, on by default, switchable off at any time), sends eligible business names, hashed sender phone numbers, business/category metadata, a sender country-code guess and a random installation identifier. The service also stores a keyed hash of the network part of the contributor's IP address, to count separate reporters; the address itself is not stored. Private message content and the user's own account phone number are not sent to this service.

## Remote code

Select **No, I am not using remote code**.

If an explanation field remains visible:

All executable extension code, including the wa-js library, is included in the uploaded extension package. The external spam list is JSON data only and is not evaluated as code. No JavaScript or WebAssembly is downloaded for execution.

## Privacy policy URL

https://dearcustomer.kanishkdan.com/privacy

## Data usage

The following categories apply to the audited code, including its local processing:

- **Personally identifiable information:** Sender names and phone numbers, chat identifiers, a persistent random installation identifier, and service request metadata such as IP addresses. A business display name can identify an individual.
- **Personal communications:** Recent WhatsApp messages are read locally to identify and classify senders. If the user selects Report, message context can be sent to WhatsApp through its reporting feature.
- **Website content:** Chat text, sender information and related WhatsApp Web content are processed in the page.
- **User activity:** Local action/run history and optional public contribution counts and timestamps. No general browsing analytics or keystroke tracking.

Do not select "no data collected" merely because message analysis happens locally. These are the categories established by this audit; any additional data use added to the extension or hosting must also be disclosed. Message text can itself contain sensitive information, so the privacy policy explicitly describes that scope.

## Certifications

Review and check all three certification statements at the bottom of the dashboard:

- No sale or transfer of user data outside the policy's approved uses.
- No use or transfer for purposes unrelated to the extension's single purpose.
- No use or transfer to determine creditworthiness or for lending.

The current source has no advertising or analytics integrations and uses data for its disclosed features. Optional public sharing is disclosed in the extension and privacy policy. These attestations also apply to the publisher's actual practices outside this repository.

Click **Save draft** after completing the fields. This prepares the listing; it does not establish review approval.

## Sources checked

- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/scripting
