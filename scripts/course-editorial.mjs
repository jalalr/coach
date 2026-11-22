// Apply this filter to the published personal-development edition. Source files are kept separately.
const directPromotion = /\b(?:multi[\s-]*level\s+market\w*|MLM|network\s+market\w*|marketing|marketed|affiliat\w*|down[\s-]*lines?|up[\s-]*lines?|recruit\w*|prospecting|prospects|advertis\w*|adverts?|infomercials?|sales(?:man|men|person|people)?|selling|sell(?:s|ing)?\s+(?:it|them|products?|books?|CDs?|anything)|direct\s+sell\w*|referr(?:al\w*|ing\s+people)|product\s+placement|promotional|lead\s+generation|hot\s+leads?|compensation\s+plan|commission\s+(?:payments?|plan|structure)|roll\s*up\s+commissions?|override\s+commissions?|AMWAY|QVC|Nutri\s*sooner|residual\s+income|passive\s+income|business\s+opportunit\w*|perpetual\s+money\s+making\s+machine)\b/i;
const programPitch = /\b(?:benefits\s+(?:of\s+)?(?:joining|becoming\s+a\s+member|(?:an?\s+)?membership)|(?:buy|buying|purchas\w*|sponsor\w*|work|find(?:ing)?)\s+(?:\w+\s+){0,2}leads?|sign(?:ed|ing)?[\s-]+up\s+(?:\w+\s+){0,4}(?:people|members|employees)|sign\s+up\s+for\s+(?:a\s+cruise|dream\s+opportunities)|customer\s+sign\s+up|member\s+buy[\s-]*in|member\s+purchas\w*|membership\s+dues|inquir\w*\s+about\s+membership|(?:buy|sell)\s+(?:your\s+ideas|John Jones)|make\s+money\s+faster|earn\s+large\s+profits\s+through\s+(?:their\s+)?membership|join\w*\s+the\s+network|level\s+\d+\s+membership|upper\s+levels\s+of\s+membership|new\s+member\s+to\s+the\s+club|club\s+offers\s+amenities|Perks\s+Club|promot\w*\s+(?:\w+\s+){0,2}(?:programs?|products?|club|new\s+concept))\b/i;
const commercialPromotion = /\b(?:buying|selling|sold) (?:\w+\s+){0,4}(?:leads|memberships?|products?|book\w*|CDs?|tapes|seminars|paint)\b|\b(?:get people to (?:join|buy)|get someone to buy|generation of leads|lead program|show(?:ing)? (?:the|their) plan|discounts? for (?:certain|new|prospective) members|money making venture, you have to have a high level of belief|rec(?:eive|eiving) a catalog|details on a promotion)\b/i;
const brand = /\b(?:global information network|GIN|GYN|JIN)\b/i;
const institutionalPitch = /\b(?:memberships?|becom\w*\s+(?:a\s+)?members?|customers|clients|benefits|join\w*|earn\w*|profits|club|dues|welcome\b|event|presentation|conferenc\w*|seminar\w*|cruise|program\s+offer|train\w*\s+for\s+new\s+members)\b/i;
const skipLessons = new Set([
  '62c5f8e416d8ee7d', // Level 1 business growth talk based on an MLM plan
  '728ab5ccfaebdb14', // Level 1 promotional and MLM regulatory discussion
  '4c5e544a3bc4695e', // Level 2 affiliate operations and paid leads
  '6d6dcc6a5c71e776', // Level 2 affiliate enrollment and sponsoring
  'ff7b05df6ade8d05', // Level 2 duplicate affiliate operations session
  '59355f06b2487031', // Level 4 sales instruction
  '52026a1c9352e0a4', // Level 4 sales experience example
  'f9be1234b8afccd6', // Level 4 membership upgrade
]);
const sentenceSplitter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function isMarketing(value) {
  if (typeof value !== 'string') return false;
  const text = value.replace(/[‐‑‒–—−]/g, '-').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ');
  return directPromotion.test(text) || programPitch.test(text) || commercialPromotion.test(text) ||
    (brand.test(text) && institutionalPitch.test(text));
}

export function personalLesson(lesson) {
  if (skipLessons.has(lesson.id) || isMarketing(lesson.title) || isMarketing(lesson.source?.split(/[\\/]/).at(-1))) return null;
  const summary_sections = lesson.summary_sections.flatMap(note => {
    if (!isMarketing(note.text)) return [note];
    const sentences = [...sentenceSplitter.segment(note.text)].map(item => item.segment.trim()).filter(Boolean);
    const kept = sentences.filter(sentence => !isMarketing(sentence));
    const text = kept.join(' ');
    if (!kept.length || kept.length * 2 < sentences.length || isMarketing(text)) return [];
    return [{ ...note, text }];
  });
  if (!summary_sections.length && lesson.summary_sections.length) return null;

  const relevant = evidence => !evidence || !lesson.summary_sections.length || summary_sections.some(note =>
    note.source.start_seconds < evidence.end_seconds && note.source.end_seconds > evidence.start_seconds);
  return {
    ...lesson, summary_sections,
    objectives: lesson.objectives.filter(item => ![item.topic, item.objective, item.success_criterion].some(isMarketing) && relevant(item.evidence)),
    practice: lesson.practice.filter(item => !isMarketing(item.question) && relevant(item.evidence)),
  };
}
