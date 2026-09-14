# Dear Customer 1.0.2 — launch handoff

Version 1.0.2 is live on the Chrome Web Store: https://chromewebstore.google.com/detail/dear-customer/lleodoeagdgcfbjcippnlijaikehgfpe

On 14 September 2026, the landing page was deployed with the live Add to Chrome link, booking/mixed-message FAQ, clarified reporting claims, and a self-hosted social/video preview image. The replacement video is now enabled (Worker version acc7ebf2-6871-49ed-9631-8c46c90bf484). Home, privacy, image, Wall and JSON routes were verified live.

Replacement video: https://www.youtube.com/watch?v=OnTBwxdliI0. YouTube reports it playable with embedding allowed, and the live landing page uses this ID in its click-to-load player. The prior store video QauQmaZ6SiQ has been removed by its uploader. The store dashboard displayed a review-submission confirmation; the submitted video's URL has not been verified. The user is handling browser steps. GitHub publication of these local changes and a real WhatsApp acceptance run remain unverified.

## 1.0.3 safety release (14 September 2026)

Built as `dist/dear-customer-1.0.3.zip`; not yet uploaded to the store. Store screenshots in `store/screenshots/` were regenerated from the 1.0.3 UI (screenshot 1 no longer shows a Delete tile).

- Delete is gone. Choices saved by older versions with delete switched on are stripped when history loads.
- Saved contacts on the WhatsApp Business app are never pre-ticked, and their plain messages never count as promotions.
- Each number is classified by everything it sends. Numbers that only send updates are left alone. Numbers that send both only get WhatsApp's marketing opt-out and a promotions-only unsubscribe button: no block, report, archive, "disable all" or typed STOP.
- WhatsApp's opt-out is skipped when WhatsApp's own switch says it's off for the account; when the switch can't be found it runs as before. Every number a ticked business used is blocked and archived; only numbers active in the chosen period are reported, capped at 25 per run and 50 per day.
- Nothing is saved before stored history loads, so an early save can't wipe the ignore list or past runs.
- `window.__bouncer` is read-only, can't start a run, and is off unless `localStorage.dearcustomer.debug` is `1`.
- The launcher is an icon in WhatsApp's left sidebar, placed in the first free slot above Settings and the profile picture, instead of a pill covering the profile. Without a sidebar it stays a corner pill. Until the first open it pops in with a pulsing ring and a callout beside it (with the live count once scanned; people upgrading from the corner pill are told it moved). The callout is gone for good after the first open or its ×, stored as `introduced` in history.
- The first screen after setup is a proper call to action: icon, one line on what happens, and a full-width Look for businesses button.
- Adding bounced businesses to the Wall is a clearly labelled, pre-ticked choice on the mandatory setup screen (on for new installs; existing users keep their stored setting, off unless they turned it on). The results screen shows a full-width Add to the Wall button when it is off. Privacy page, listing and privacy-form wording say so.
- The Wall only accepts official business accounts. A business needs three installs on three different networks, counted by a keyed hash of the IPv4 /24 or IPv6 /48; the address itself is never stored. `scripts/suppress.sh` hides a business at once.

Wall changes are live: D1 migration applied (`reports.net_hash`, `suppressed`), `IP_SALT` secret set, Worker version f792360d-865f-47e7-8301-6c23d2dee041. Three fake installs from one network did not list a probe business, a non-official account was rejected, and the takedown round trip worked. Probe rows were deleted.

Verified: 19 logic tests, the offline UI suite (zero page errors, zero network requests), and a browser pass with the real extension on web.whatsapp.com against mocked WhatsApp:
- Mom was not ticked.
- Myntra got the opt-out plus a tap on "Stop promotions" only.
- Kiwi's OTP number was left alone.
- Kiwi's promo number got the full set of actions.
- No delete call was made, and nothing was sent to the Wall.

The landing page FAQ describes the new behaviour and tells 1.0.2 users to untick businesses they still buy from until their copy updates.

To do: upload the 1.0.3 zip, replace the store description line about deleting with "Archive chats. Unarchive any time.", and run one real-account pass on a sender that sends both orders and offers. In the WhatsApp Web console, `require('WAWebMarketingMessagesUserFeedbackGatingUtils').isMMOptOutEnabled()` shows whether WhatsApp's own opt-out is switched on for the account.

## Release files

- `dist/dear-customer-1.0.2.zip` — Chrome Web Store / unpacked installation package.
- `store/LISTING.md` — updated description, review notes and install-link instructions.
- `store/LAUNCH-POSTS.md` — replies about mixed messages and marketing budgets, plus the final launch post.
- `store/video/YOUTUBE-UPLOAD.md` — replacement upload title, description and store update steps.
- `store/PRIVACY-FIELDS.md` — exact privacy form answers and data category guidance.
- `store/promo-small-v2-440x280.png` — new small promo tile.
- `store/video/youtube-thumbnail-v1-1280x720.jpg` — YouTube thumbnail.
- `store/screenshots/` — five 1280×800 screenshots of the extension UI using labelled fictional demo data.
- `docs/social-1280x640.png` — existing GitHub social preview.
- `dist/qa/share-card.png` — sample exported card from the browser check.
- `community/src/index.js` — deployed landing/privacy copy explaining local message and sender processing, native WhatsApp reporting, Wall contributions, X drafts, saved cards and Limited Use. The landing page now links to the live Chrome Web Store listing.

## What changed

- Removed bulk Ignore. Added Undo, a visible Ignored list, individual Restore and Restore all. Ignored or hidden senders cannot enter a run through Select all or stale selection.
- Fixed each business's number expander; the History control now has its own action.
- Added readable per-business statuses and expandable action outcomes, including waiting, skipped, cancelled, failed and timed-out actions.
- Progress updates preserve the list and scroll position. Stop finishes the action in flight and prevents later actions from starting. Results open at the top.
- Failed-only runs no longer claim to be bounced or enter successful history. Cards, drafts and Wall payloads exclude numbers with no successful action. Existing older history is retained because previous versions did not store enough evidence to reconstruct every outcome.
- Added Post to X beside Save share card and removed Copy as text. The draft contains aggregate results and the installation link. Users attach the saved PNG themselves and decide whether to publish.
- Kept delete off by default. Removed redundant activeTab permission in 1.0.2; existing WhatsApp host access covers the required tab access and scripting. No new permissions or runtime dependencies.

## Verified locally

- 11 logic regressions passed.
- Offline Chromium UI suite passed with zero page errors and zero network requests.
- Verified success, partial, failed and stopped screens; ignored-list recovery; stable progress; unblocking; Wall payload filtering; X draft URL; and PNG download.
- Store screenshots use a 1280×800 viewport. The UI also passed an 800×600 compact-window check.
- JavaScript syntax and release ZIP contents checked.
- Chromium loaded the actual 1.0.2 extension without activeTab; WhatsApp tab lookup, MAIN-world script injection and content-script messaging all passed on an offline fixture.
- Privacy route tested locally and verified live after deployment; the small promo tile is a 440×280 PNG without alpha.

## Before public launch

1. Reload the extension in `chrome://extensions`, then refresh WhatsApp Web so it runs 1.0.2.
2. Run a small real-account acceptance pass on senders you actually want to act on. Check native opt-out, report and archive against WhatsApp; open Details to verify the outcome. STOP sends a reply if Opt out is enabled. Confirm Stop prevents subsequent actions, and Unblock works. These external effects were not exercised by the offline suite.
3. Privacy and landing copy are deployed. Recheck the privacy URL in the store draft.
4. Version 1.0.2 is already publicly available. In the store dashboard, confirm the submitted listing update references https://www.youtube.com/watch?v=OnTBwxdliI0 and check its review status. A video-only update needs no new ZIP.
5. Publish the matching GitHub release, attach the ZIP, and set `docs/social-1280x640.png` as the repository social preview.
6. STORE_URL and YOUTUBE_VIDEO_ID are set; Add to Chrome and the replacement video are live on the landing page. Use the store link and attach the new video directly to the launch post.

## X launch post draft

Use the final launch post in `store/LAUNCH-POSTS.md` and attach the replacement video file directly to X. That file also contains replies about mixed booking/promotional messages and marketing budgets. Nothing has been posted or scheduled by the assistant.
