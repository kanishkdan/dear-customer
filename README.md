<p align="center">
  <img src="docs/icon.png" width="76" alt="">
</p>

<h1 align="center">Bouncer</h1>

<p align="center">
  Every business that spams you on WhatsApp, <b>out in one click</b>.<br>
  Opts out, STOPs, reports, blocks, deletes. Counts the numbers they burned on you.
</p>

<p align="center">
  <a href="https://bouncer.kanishkdan.com">bouncer.kanishkdan.com</a> ·
  <a href="#install">install</a> ·
  <a href="#how-it-finds-promotional-senders">how it works</a> ·
  <a href="#the-wall-of-shame">wall of shame</a> ·
  <a href="https://bouncer.kanishkdan.com/privacy">privacy</a>
</p>

---

Blocking a spammer on WhatsApp does nothing. They have a bag of numbers and next week they're back from a new one. Bouncer is a Chrome extension for WhatsApp Web that finds every business sending you promotions, shows how many numbers each one has burned on you, and throws them out in one click: WhatsApp's own marketing opt-out, STOP, report, block, delete. **Nothing leaves your browser unless you choose to add a business to the public Wall of Shame.**

## Install

Chrome Web Store listing is pending review. Until then:

1. Download the latest release zip from the Releases page, or clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.
3. Open <https://web.whatsapp.com> and link your phone if you haven't.
4. A **Bouncer** pill appears bottom-left once your chats are showing. Click it, or click the toolbar icon.

Chrome 111 or newer. Works on Chromium browsers that support Manifest V3 content scripts in the page world (Edge, Brave, Arc).

## Use

- Bouncer reads your chats and opens on **Promotional**: every business that sent you marketing in the period you pick (this week by default). Each row shows the message count, the last message, and in red how many different numbers that business has ever used on you. Rows are ranked by that count.
- Promotional rows are ticked. Click a name to open the chat and check. Switch to **All** to see senders that only sent order updates, alerts or codes, small businesses on the WhatsApp Business app, and unknown numbers not in your contacts.
- The first time you open it, Bouncer asks what you want to do with these messages and shows the six actions as cards with what each one does and whether it can be undone. The default is opt out, STOP, report, block and archive; delete is off. **Change** under the Bounce button brings that screen back.
- Press **Bounce**. Progress shows per number, and a Stop button ends the run early. When it finishes you get a stamp, a count, a share card, and the option to add the businesses you bounced to the public Wall of Shame. Only the ones that were promotional to you are preselected, and you can tick "add automatically after every run".

## How it finds promotional senders

1. WhatsApp's own tag. Every template message carries the category the business declared to Meta: marketing, utility or authentication. Marketing is promotional, authentication is not.
2. Words. A utility tag does not win on its own, because businesses in India register ad templates as utility to dodge marketing pricing. Loan, pre-approved, offer, cashback, EMI, apply now and friends outrank a utility tag. OTP, delivered, debited, invoice and friends mark an alert.
3. Buttons. A template with a call-to-action button and no transactional words is promotional. OTPs don't come with "Apply now".
4. The public list, as a tie-break only. A business many people bounced for promotions, whose messages to you carry no signal either way, is treated as promotional. A business whose messages to you are alerts stays an alert sender however many people bounced it. The list never ticks a business for you.

Business detection itself uses the contact flags WhatsApp exposes, business markers on the messages, and whether the sender is in your address book.

The word lists live in `src/keywords.js`: promotional phrases, transactional phrases, and the opt-out button labels Bouncer will tap, strongest first. They're plain lists, tuned for India today. If spam where you live says something else, edit the file and open a pull request.

## What each action does

| Action | Who enforces it | Effect |
| --- | --- | --- |
| Stop marketing | WhatsApp, on the business account | The same request WhatsApp's "Stop offers and announcements" button sends. Meta then refuses that business's marketing templates to you, whichever number they use. Runs first. Availability depends on WhatsApp having rolled the control out to your account. |
| Send STOP | The business's messaging vendor | Looks for an opt-out button on their latest template, such as "Disable all communication", "Unsubscribe" or "STOP", taps the strongest, waits for a bot follow-up and taps that too. Types the word STOP only when there is no button, because most vendors act on the button id, not typed text. Latest live number only, at most 30 per run. |
| Report | WhatsApp | Sends the latest message from that number to WhatsApp. Reports lower the number's quality rating until Meta throttles or bans it, which is why spammers rotate numbers. |
| Block | WhatsApp | That number can never message you again. Undo from the results screen. |
| Archive chat | Your WhatsApp | Moves the chat out of your list. It comes back if they message you again. On by default instead of delete. |
| Delete chat | Your WhatsApp | Removes the chat on all your devices. |

## Privacy

Everything runs in your browser. Nothing about your chats leaves it unless you press **Add to the Wall of Shame**, and then only the business name, a SHA-256 hash of each number it used, whether it is an official Business Platform account, a country-code guess, and a random per-install id so one person counts once. Full policy: <https://bouncer.kanishkdan.com/privacy>.

## Honest limits

- Your phone still buzzes once per new number. Phone and browser receive a message at the same instant.
- Automation is against WhatsApp's terms. In practice bans target bulk senders, and Bouncer sends at most one STOP per business with pauses between, but the risk is not zero.
- WhatsApp Web ships updates often. Bouncer talks to WhatsApp Web through [wa-js](https://github.com/wppconnect-team/wa-js), bundled unmodified. When WhatsApp changes internals it can break until wa-js is updated; drop a newer `dist/wppconnect-wa.js` into `vendor/` and reload the extension.
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

`community/` is a Cloudflare Worker with a D1 database. `POST /report` takes the extension's reports, `GET /list.json` is the public data, `/` is the Wall of Shame, `/privacy` is the policy. To run your own: `npx wrangler d1 create bouncer-list`, put the id in `wrangler.jsonc`, `npx wrangler d1 execute bouncer-list --remote --file schema.sql`, `npx wrangler deploy`, then change `LIST_URL` in `src/background.js` and the matching `host_permissions` entry in `manifest.json`.

## Debug

Open DevTools on the WhatsApp Web tab. `window.__bouncer.state` is the live state. Every action during a run logs a `[Bouncer]` line with its outcome and timing. If something you know is spam isn't listed, press **Copy diagnostics** on the empty state and open an issue with it; it contains business names and masked numbers only.

## Licence

MIT. wa-js is Apache 2.0, see `NOTICE`. Not affiliated with WhatsApp or Meta.
