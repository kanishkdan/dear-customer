# Chrome Web Store listing

Everything the Developer Dashboard asks for, in order. Upload `dist/bouncer-1.0.0.zip` from `scripts/package.sh`.

## Store listing

**Name:** Bouncer

**Summary (132 max):** Finds every promotional sender in your WhatsApp Web chats and opts out, STOPs, reports, blocks and deletes them in one click.

**Category:** Productivity → Communication

**Language:** English

**Description:**

The revenge button for WhatsApp spam.

Bouncer runs inside WhatsApp Web. Open it and it lists every business that has been sending you promotions, ranked by how many different numbers each one has burned on you. Tick the ones you're done with and press Bounce. For each number it:

• Stops marketing — WhatsApp's own "Stop offers and announcements" opt-out, which Meta enforces on the whole business account, not just one number
• Sends STOP — taps the opt-out button on their latest message ("Disable all communication", "Unsubscribe", "STOP") the way the vendor's bot expects, and only types STOP when there's no button
• Reports the number to WhatsApp
• Blocks it
• Deletes the chat

Businesses that only send order updates, OTPs and alerts are kept out of the way under All, so your bank and your grocer stay untouched. Click any name to open the chat and check before you act.

Optionally add the businesses you bounced to the public Wall of Shame at bouncer.kanishkdan.com, where they're ranked by how many people bounced them and how many numbers they burned. Names and hashed numbers only, never your data.

Everything runs in your browser. Nothing about your chats leaves it unless you choose to add a business to the list.

Requires a WhatsApp account linked to WhatsApp Web. Not affiliated with WhatsApp or Meta.

**Screenshots (1280×800, up to 5):** take these on your own WhatsApp Web. Keep the chat list visible on the left so the context is clear.
1. The list open on Promotional with a few rows ticked.
2. Mid-run, progress in the footer.
3. The results screen with the stamp.
4. The Wall of Shame page.

**Small promo tile (440×280):** `store/promo-small-440x280.png`
**Marquee (1400×560, optional):** `store/promo-marquee-1400x560.png`
**Icon (128):** `icons/icon128.png`

## Privacy practices tab

**Single purpose:** Lets a WhatsApp Web user find the businesses sending them promotional messages and opt out of, STOP, report, block and delete them.

**Permission justifications:**
- `storage` — remembers which business senders it has seen and the numbers they used, so it can count numbers burned across weeks; stores a random id and a cached copy of the public list.
- `activeTab` — opens the panel in the current WhatsApp Web tab when the toolbar icon is clicked.
- `scripting` — injects the bundled wa-js library (vendor/wppconnect-wa.js, shipped inside the extension, not remote) into WhatsApp Web after the user has logged in. It cannot be a static content script because injecting it before login breaks it.
- Host `https://web.whatsapp.com/*` — the only site the extension works on.
- Host `https://bouncer.kanishkdan.com/*` — downloads the public list of reported businesses every six hours and, only when the user presses "Add to the Wall of Shame", uploads the business names and hashed numbers they ticked.

**Remote code:** No. All code ships in the package.

**Data usage:** Website content (business names and hashed phone numbers from WhatsApp chats), only when the user explicitly submits them. Not personally identifiable information about the user. Not sold, not used for purposes unrelated to the extension's single purpose, not used for creditworthiness or lending.

**Privacy policy URL:** https://bouncer.kanishkdan.com/privacy

## Review notes (for the reviewer box)

Testing requires a WhatsApp account linked to web.whatsapp.com. After linking, wait for the chat list to appear, then click the Bouncer pill at bottom-left or the toolbar icon. The panel lists business senders; nothing is sent or changed until the user presses Bounce. The extension automates actions the user could do by hand in WhatsApp Web (block, delete, report, reply, opt out). The bundled library wa-js is open source (Apache 2.0, github.com/wppconnect-team/wa-js) and is included unmodified.

## Things that can get it rejected, and the answer

- **Trademark.** The name is "Bouncer", not "Bouncer for WhatsApp". "WhatsApp Web" appears only to describe compatibility, with a non-affiliation line.
- **Host permissions scope.** Two hosts, both justified above. Do not add more.
- **User data transmission.** Opt-in per run, disclosed in the UI at the moment of sending, covered by the policy.
- **Automation of a third-party site.** Disclosed plainly in the description.

## After approval

- Put the store URL in README.md under Install and on the site's "Get Bouncer" button (`REPO_URL` in `community/wrangler.jsonc` can point at the store instead of GitHub).
- Tag a GitHub release with the same zip.
