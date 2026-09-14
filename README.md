<p align="center">
  <img src="docs/icon.png" width="76" alt="">
</p>

<h1 align="center">Dear Customer</h1>

<p align="center">
  <b>Dear Customer. No.</b><br>
  Every business that spams you on WhatsApp, out in one click.<br>
  Opts out, STOPs, reports, blocks, archives. Counts the numbers they burned on you.
</p>

<p align="center">
  <a href="https://dearcustomer.kanishkdan.com">dearcustomer.kanishkdan.com</a> ·
  <a href="#install">install</a> ·
  <a href="#how-it-finds-promotional-senders">how it works</a> ·
  <a href="#the-wall-of-shame">wall of shame</a> ·
  <a href="https://dearcustomer.kanishkdan.com/privacy">privacy</a>
</p>

---

Every one of these messages opens the same way. Blocking the sender does nothing. They have a bag of numbers and next week they're back from a new one. Dear Customer is a Chrome extension for WhatsApp Web that finds every business sending you promotions, shows how many numbers each one has burned on you, and throws them out in one click: WhatsApp's own marketing opt-out, STOP, report, block and archive. **Chat processing stays in your browser. Wall contributions and sharing are your choice.**

## Install

**[Add to Chrome](https://chromewebstore.google.com/detail/dear-customer/lleodoeagdgcfbjcippnlijaikehgfpe)**

Open <https://web.whatsapp.com> after installing. Once your chats load, click the **Dear Customer** icon in WhatsApp's left sidebar, above Settings, or the toolbar icon.

For development or manual installation:

1. Download the latest release zip from the Releases page, or clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. Open <https://web.whatsapp.com> and link your phone if you haven't.
4. A **Dear Customer** icon appears in WhatsApp's left sidebar, above Settings, once your chats are showing. Click it, or click the toolbar icon.

Chrome 111 or newer. Works on Chromium browsers that support Manifest V3 content scripts in the page world (Edge, Brave, Arc).

## Use

- Dear Customer reads your chats and opens on **Promotional**: every business that sent you marketing in the period you pick (this week by default). Each row shows the message count, the last message, and in red how many different numbers that business has ever used on you. Rows are ranked by that count.
- Promotional rows are ticked. Click a name to open the chat and check. Switch to **All** to see senders that only sent order updates, alerts or codes, small businesses on the WhatsApp Business app, and unknown numbers not in your contacts.
- The first time you open it, Dear Customer asks what you want to do with these messages and shows the four choices as tiles with what each one does and whether it can be undone. Opt out is one choice that runs both opt-out mechanisms. The default is opt out, report, block and archive. There is no delete: archive clears the chat list and can be undone. **Change** under the Bounce button brings that screen back.
- Untick a sender to skip this run. **Ignore** skips that business in future scans too. The notice has **Undo**, and **Ignored (N)** above the list lets you restore individual senders or **Restore all**. Restored senders stay unticked until you select them. Ignored senders cannot be included by Select all or Bounce.
- Press **Bounce**. Each business shows Queued, its current action, Completed, Partly completed, Failed, or Not completed. **Details** shows every requested action, including skipped actions, timeouts and failure reasons. Progress leaves your scroll position alone. **Stop** finishes the action already in flight, then leaves remaining actions unrun.
- Results open at the top. Counts and history include only numbers with at least one successful or already-completed action; partial and stopped runs are labelled. **Post to X** opens an editable draft with aggregate results and the site link. **Save share card** downloads a PNG you can attach yourself; the card can include business names. Neither button publishes a post.
- You can also add successful promotional business senders to the public Wall of Shame. Use **Choose which** to review them, or opt into adding them automatically after future runs.

## How it finds promotional senders

1. WhatsApp's own tag. Every template message carries the category the business declared to Meta: marketing, utility or authentication. Marketing is promotional, authentication is not.
2. Words. A utility tag does not win on its own, because businesses in India register ad templates as utility to dodge marketing pricing. Loan, pre-approved, offer, cashback, EMI, apply now and friends outrank a utility tag. OTP, delivered, debited, invoice and friends mark an alert.
3. Buttons. A template with a call-to-action button and no transactional words is promotional. OTPs don't come with "Apply now".
4. The public list, as a tie-break only. A business many people bounced for promotions, whose messages to you carry no signal either way, is treated as promotional. A business whose messages to you are alerts stays an alert sender however many people bounced it. The list never ticks a business for you.

Business detection itself uses the contact flags WhatsApp exposes, business markers on the messages, and whether the sender is in your address book.

### What about bookings and order updates?

Dear Customer flags promotional **senders**, not individual messages to hide. A business that sends both offers and booking confirmations can appear in Promotional. Blocking a number stops both kinds of message from that number. If you need updates from Myntra, BookMyShow, MakeMyTrip or another business, leave it unticked or choose **Ignore**. You can restore ignored senders later.

Opt-out and STOP behavior depends on the business and WhatsApp; some unsubscribe buttons stop all communication. Leaving the business unselected is the safest way to preserve its useful messages.

The word lists live in `src/keywords.js`: promotional phrases, transactional phrases, and the opt-out button labels Dear Customer will tap, strongest first. They're plain lists, tuned for India today. If spam where you live says something else, edit the file and open a pull request.

## What each action does

| Action | Who enforces it | Effect |
| --- | --- | --- |
| Opt out, part one | WhatsApp, on the business account | The same request WhatsApp's "Stop offers and announcements" button sends. Meta then refuses that business's marketing templates to you, whichever number they use. Runs first. Availability depends on WhatsApp having rolled the control out to your account. |
| Opt out, part two | The business's messaging vendor | Looks for an opt-out button on their latest template, such as "Disable all communication", "Unsubscribe" or "STOP", taps the strongest, waits for a bot follow-up and taps that too. Types the word STOP only when there is no button, because most vendors act on the button id, not typed text. Latest live number only, at most 20 per run and 40 per day. |
| Report | WhatsApp | Reports the selected sender with message context. WhatsApp decides whether to take enforcement action. |
| Block | WhatsApp | Stops messages from that number, including booking and order updates. Undo from the results screen. |
| Archive chat | Your WhatsApp | Moves the chat out of your list. Unarchive any time. |

## Privacy

Chat processing runs in your browser. If you choose **Add to the Wall**, or leave automatic contribution on (offered during setup, on by default for new installs, switch it off any time), the extension sends the business name, a SHA-256 hash of each number it used, whether it is an official Business Platform account, a country-code guess, and a random per-install id so one person counts once. **Post to X** sends aggregate results and the site link to an editable X draft; it omits business names, phone numbers and message content. Image cards are saved locally and can include business names and counts. Full policy: <https://dearcustomer.kanishkdan.com/privacy>.

## Is this safe for my number?

WhatsApp bans accounts for sending, not for receiving. Its anti-spam system scores outbound messages, especially many of them to people who never wrote to you, and it bans unofficial clients it can fingerprint. Dear Customer is neither of those things: it runs inside the official WhatsApp Web client and calls the same functions the buttons call, so the server sees an ordinary linked device. Opting out, reporting, blocking and archiving are all things you could do by hand and none of them send a message.

The one action that does send a message is STOP, and it is the only real exposure. Dear Customer keeps it small: one STOP per business, only to a number that messaged you in the last 30 days and only as a reply inside that existing conversation, at most 20 per run and 40 per day, spaced several seconds apart. Replying once to a business that wrote to you first is about as far from a spam pattern as a message can be. If that still worries you, untick Opt out on the setup screen and Dear Customer sends nothing at all.

What would raise the risk: modifying the code to send more, faster, or to numbers that never messaged you. Don't.

## Safeguards

Built in to keep your account, the people you know, and the businesses on the Wall safe:

- **People in your contacts are never pre-ticked.** A saved contact who uses the WhatsApp Business app is treated as a person. Their plain messages never count as promotions, and bouncing one asks for a second click.
- **Updates keep coming.** Each number is classified by everything it sends you. A number that only sends orders, bookings or OTPs is left alone. A number that sends both only gets WhatsApp's marketing opt-out and a promotions-only unsubscribe button, never a block, report, archive, "disable all" button or typed STOP.
- **Every number a ticked business used is blocked and archived.** Only numbers active in the chosen period are reported, capped at 25 per run and 50 per day. STOP replies are capped at 20 per run and 40 per day.
- **WhatsApp's opt-out is skipped when WhatsApp says it's off** for your account, so the extension never sends a request the official app wouldn't.
- **No delete.** Archive clears the chat list and can be undone.
- **The Wall needs three separate users on different networks**, accepts only official business accounts, and any business can be hidden in seconds.
- **Nothing on the page can start a run** except the Bounce button. The debug handle is off by default and read-only.

## Honest limits

- Your phone still buzzes once per new number. Phone and browser receive a message at the same instant.
- Automation is against WhatsApp's terms. In practice bans target bulk senders and unofficial clients, and Dear Customer is neither, but the risk is not zero. See "Is this safe for my number?" above.
- WhatsApp Web ships updates often. Dear Customer talks to WhatsApp Web through [wa-js](https://github.com/wppconnect-team/wa-js), bundled unmodified. When WhatsApp changes internals it can break until wa-js is updated; drop a newer `dist/wppconnect-wa.js` into `vendor/` and reload the extension.
- wa-js is injected only after your chat list is on screen, never on the QR page, because injecting early makes it cache WhatsApp's lazily loaded modules as missing.

## Layout

```
manifest.json            MV3 manifest
src/keywords.js          the word lists: promotional, transactional, opt-out buttons. Edit these.
src/engine.js            runs inside WhatsApp Web: scan, classify, act, UI
src/bridge.js            isolated-world shim: chrome.storage, badge, list fetch relay
src/background.js        service worker: toolbar click, badge, injects wa-js after login, talks to the site
vendor/                  wa-js 4.6.0 and its licences
icons/                   toolbar icons
community/               the site: Cloudflare Worker + D1 behind the Wall of Shame and /privacy
store/                   Chrome Web Store listing copy, promo images, blog post
scripts/package.sh       builds the store zip into dist/
```

## The Wall of Shame

A business is only named on the public Wall once **three separate users on different networks** have bounced it for promotional messages, and only official WhatsApp business accounts can be listed. Reporters are counted by install id and by a keyed hash of the network part of their IP address (IPv4 /24, IPv6 /48), so one person can't pose as three; the address itself is never stored. Below the threshold, reports and the numbers behind them are stored but never published. The threshold is `MIN_REPORTERS` in `community/wrangler.jsonc`; the hash key is the `IP_SALT` Worker secret.

Anyone listed can ask to be removed through the issue tracker. Hide a business immediately with `scripts/suppress.sh "Business Name" "removal request"`, and undo with `scripts/suppress.sh --undo "Business Name"`.

`community/` is a Cloudflare Worker with a D1 database. `POST /report` takes the extension's reports, `GET /list.json` is the public data, `/` is the landing page, `/wall` is the Wall of Shame, `/privacy` is the policy. To run your own: `npx wrangler d1 create bouncer-list`, put the id in `wrangler.jsonc`, `npx wrangler d1 execute bouncer-list --remote --file schema.sql`, `npx wrangler deploy`, then change `LIST_URL` in `src/background.js` and the matching `host_permissions` entry in `manifest.json`.

## Debug

Open DevTools on the WhatsApp Web tab. Run `localStorage.setItem('dearcustomer.debug', '1')` and reload, then `window.__bouncer.state` is the live state. Every action during a run logs a `[Dear Customer]` line with its outcome and timing. If something you know is spam isn't listed, press **Copy diagnostics** on the empty state and open an issue with it; it contains business names and masked numbers only.

## Development checks

Run `node --test tests/engine.test.cjs` for the selection, action, cancellation, history and sharing regressions. No dependencies are required.

`tests/ui-smoke.cjs` exercises the UI in Chromium with fictional data and all network requests blocked. It requires `playwright-core` and an installed Chromium executable supplied through `CHROMIUM_PATH`. It writes screenshots to `dist/qa/`. See `tests/README.md` for details.

Build the Chrome Web Store package with `bash scripts/package.sh`. Release materials and the remaining live-session checks are in [store/LAUNCH.md](store/LAUNCH.md).

## Licence

MIT. wa-js is Apache 2.0, see `NOTICE`. Not affiliated with WhatsApp or Meta.
