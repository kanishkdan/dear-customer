// Dear Customer keyword lists. Plain phrases, matched case-insensitively on word
// boundaries. Edit these to teach Dear Customer what promotional and transactional
// messages look like where you live. Pull requests welcome.
//
// Rules of thumb:
//   - A message with more promotional hits than transactional hits reads as an ad.
//   - Ties go to transactional: a statement that mentions a credit card is a statement.
//   - Entries starting with "re:" are regular expressions; everything else is a
//     literal phrase.
//   - WhatsApp's own "marketing" tag on a template always wins over these lists.
window.__bouncerKeywords = {
  // Any of these in a message: it's trying to sell you something.
  promotional: [
    'offer', 'offers', 'discount', 'sale', 'deal', 'deals', 'cashback', 'coupon', 'voucher', 'promo', 'promotion',
    're:limited[- ]time', 'limited period', 'hurry', 're:last (?:day|chance)', 'exclusive', 'unlock', 'claim now',
    're:apply (?:now|today)', 're:register(?: now)?', 'book now', 'shop now', 'buy now', 'buy this', 'order now', 'grab now', 'get it now',
    'webinar', 'masterclass', 're:flat \\d+ ?%', 're:\\d+ ?% ?off', 'emi', 'emis', 'loan', 'loans', 're:pre-?approved', 'pre-qualified',
    're:credit (?:limit|card|line)', 're:instant (?:credit|loan|cash)', 'eligible', 'eligibility', 'free delivery', 'festive', 'bonanza', 'mega',
    're:special (?:offer|price)', 'upgrade', 'reward', 'rewards', 'bonus', 'gift', 'win', 'invest', 'investment', 're:mutual funds?', 'sip', 'ipo',
    'demat', 'trading', 'insurance', 'policy', 'renew', 'avail', 't&c', 're:terms (?:and|&) conditions', 're:click (?:here|below)', 're:tap (?:here|below)',
    're:download (?:the|our) app', 'new launch', 'launching', 'introducing', 're:don\'?t miss', 're:expires? (?:soon|today)', 'only for you',
    'selected customers', 'dear customer', 're:₹ ?\\d', 're:rs\\.? ?\\d', 'lakh', 'crore', 'wealth', 'earn', 're:save (?:up to|more)',
    're:zero (?:fee|cost)', 'lifetime free', 'no cost emi', '0% interest', 'just for you', 'sale is live', 'offer ends', 'flash sale',
  ],
  // Any of these: it's a receipt, a code, a bill, a delivery, something you asked for.
  transactional: [
    'otp', 're:one[- ]time password', 'verification code', 're:is your (?:code|otp)', 'do not share', 're:order (?:id|no|number|#)',
    're:has been (?:shipped|delivered|dispatched|placed|confirmed|cancelled|received|generated|processed|initiated|credited|debited)',
    'out for delivery', 'arriving', 'delivered', 're:payment (?:received|successful|failed|of|reminder|due)', 'invoice', 'receipt',
    'debited', 'credited', 'transaction', 'txn', 're:a/c', 'account ending', 'balance', 'statement', 're:bills?', 'generated',
    're:booking (?:id|confirmed)', 'pnr', 'ticket', 'boarding', 'appointment', 'reminder', 're:due (?:date|on|by)', 'pay by', 'amount due',
    'total amount', 're:minimum (?:amount )?due', 'outstanding', 're:emi (?:due|of)', 're:auto-?debit', 'mandate', 'premium due', 'renewal due',
    'password reset', 're:login (?:code|attempt)', 'verify your', 'kyc', 're:re-?kyc', 're:expir(?:es|ing|y)', 'tracking',
  ],
  // Quick-reply buttons Bouncer will tap to opt out, strongest first.
  optOutButtons: {
    strong: ['disable all', 'stop all', 'block all'],
    medium: ['unsubscribe', 're:opt[- ]?out', 'remove me', 'do not contact', 're:don\'?t contact'],
    normal: ['re:stop (?:messages|promotions|offers|marketing|receiving|these|notifications|updates|sms|alerts)'],
    soft: ['not interested', 'no thanks', 're:don\'?t send', 're:no,? thanks'],
    bare: ['re:^stop$'],
  },
};
