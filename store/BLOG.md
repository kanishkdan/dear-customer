# I built a revenge button for WhatsApp spam

Every week a loan company I have never spoken to messages me on WhatsApp. I block it. Next week it's back from a new number. Finance Buddha has done this from fourteen numbers on my phone alone. Blocking is per number. They have a bag of numbers.

So I built Dear Customer, a Chrome extension for WhatsApp Web. It reads your chats, finds every business that has been sending you promotions, and shows how many numbers each one has burned on you. Tick them, press Bounce, and for each number it:

- opts you out through WhatsApp's own "Stop offers and announcements" control, which Meta enforces on the business account rather than the number
- taps the opt-out button on their latest message, "Disable all communication" or "Unsubscribe" or "STOP", the way the vendor's bot expects it, and only types STOP when there is no button
- reports the number, blocks it, deletes the chat

Your bank's OTPs and your grocer's delivery updates stay untouched. WhatsApp stamps every template with the category the business declared, marketing or utility or authentication, and Dear Customer reads that. It also doesn't trust it blindly, because plenty of "utility" templates in India say "pre-approved loan, apply now". Words and call-to-action buttons outrank a utility tag.

Nothing leaves your browser. There is one optional step at the end: add the businesses you bounced to a public Wall of Shame, ranked by how many people bounced them and how many numbers they burned. Names and hashed numbers only.

Two honest caveats. Your phone still buzzes once per new number, because phone and browser receive the message at the same instant and nothing in a browser can prevent that. And this automates WhatsApp Web, which is against their terms. Bans in practice hit bulk senders and Dear Customer sends at most one message per business with pauses between, but it isn't zero risk.

Does it hurt them? Reports lower a number's quality rating until Meta throttles it, which is why they rotate numbers in the first place. The opt-out is the part that sticks. I have no idea if it changes their behaviour. It does clear the inbox.

Get it: dearcustomer.kanishkdan.com. Source: github.com/kanishkdan/dear-customer.
