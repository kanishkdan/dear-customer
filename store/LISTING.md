# Chrome Web Store listing

Everything the Developer Dashboard asks for, in order. Upload `dist/dear-customer-1.0.2.zip` from `scripts/package.sh`.

## Store listing

**Name:** Dear Customer

**Summary (132 max):** Find promotional senders in WhatsApp Web. Choose to opt out, report, block and archive their chats in one click.

**Category:** Communication

**Language:** English

**Description:**

Take control of promotional messages on WhatsApp Web.

Dear Customer finds businesses sending you promotions and shows how many different numbers each one has used to contact you.

Review the senders, choose your actions and press Bounce:

• Request marketing opt-outs and send STOP replies.
• Report and block selected numbers.
• Archive chats, or optionally delete them.

Ignore senders you want to keep and restore them at any time. Follow each action as it runs, stop after the current action, and see what completed or needs attention.

Chat analysis runs locally in your browser. Selected actions use your existing WhatsApp Web session; reporting can send message context to WhatsApp. Sharing results is optional: contribute business names and hashed sender numbers to the public Wall of Shame, save an image card, or open an editable X draft. Wall contributions include a random installation identifier to count each installation once. No message content is uploaded to Dear Customer.

Free and open source. Requires a WhatsApp account linked to WhatsApp Web. Not affiliated with WhatsApp or Meta.

Dear Customer. No.

**Screenshots (1280×800):** prepared in `store/screenshots/` using the actual extension UI with labelled fictional demo data.
1. `01-setup.png` — action choices and defaults.
2. `02-list.png` — promotional senders and per-business controls.
3. `04-running.png` — stable progress and action details.
4. `05-results.png` — completed results and sharing.
5. `06-partial.png` — honest partial results.

**Small promo tile (440×280):** `store/promo-small-v2-440x280.png`
**Marquee (1400×560, optional):** `store/promo-marquee-1400x560.png`
**Icon (128):** `icons/icon128.png`

## Privacy practices tab

Copy the exact fields and checkbox guidance from [PRIVACY-FIELDS.md](PRIVACY-FIELDS.md). This covers version 1.0.2, which removes redundant activeTab access, and discloses local message/sender processing as well as optional sharing.

## Review notes (for the reviewer box)

This extension helps a WhatsApp user unsubscribe from businesses that message them. It only sends a STOP reply or chooses an unsubscribe button when the user enables that action and presses Bounce. STOP replies are limited to one selected number per business, capped at 20 per run and 40 per day. Selected opt-out, report, block, archive and delete actions use the user's existing WhatsApp session.

Testing requires a WhatsApp account linked to web.whatsapp.com. After linking, wait for the chat list to appear, then click the Dear Customer pill at bottom-left or the toolbar icon. The panel lists business senders; nothing is sent or changed until the user presses Bounce. The extension automates actions the user could do by hand in WhatsApp Web (block, delete, report, reply, opt out). The bundled library wa-js is open source (Apache 2.0, github.com/wppconnect-team/wa-js) and is included unmodified.

## After approval

- Put the store URL in README.md under Install. Set `STORE_URL` in `community/wrangler.jsonc`; the landing page then changes its install button to Add to Chrome. Keep `REPO_URL` pointing at GitHub.
- Tag a GitHub release with the same zip.
