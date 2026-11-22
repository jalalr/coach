import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isMarketing, personalLesson } from './course-editorial.mjs';

const source = new URL('../../course-content/success-mastery/', import.meta.url);
const output = new URL('../.course-import/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, source), 'utf8'));
const [course, bank, grades, requirements, links] = await Promise.all([
  'course.json', 'assessment-bank.json', 'grading-keys.private.json', 'course-requirements.json', 'assessment-links.json',
].map(read));
const sourceLessonCount = course.levels.flatMap(level => level.modules.flatMap(module => module.lessons)).length;
const sourceQuestionCount = bank.sets.reduce((total, set) => total + set.items.length, 0);
if (sourceLessonCount !== 461 || sourceQuestionCount !== 3504) throw new Error('Course input is incomplete.');
const filenames = path => path?.split(/[\\/]/).at(-1);
const citation = value => ({
  source: filenames(value?.path), page: value?.page, start: value?.start_seconds, end: value?.end_seconds,
});
const documents = [];
const add = (id, payload) => documents.push({ id, payload });
const keptLessons = new Map();
const levelIndex = course.levels.map(level => ({
  level: level.level, prerequisite: level.prerequisite, topics: level.focus_topics.filter(topic => !isMarketing(topic)),
  modules: level.modules.map((module, index) => ({
    id: module.id ?? `level-${level.level}-module-${index + 1}`,
    title: isMarketing(module.title ?? module.name) ? `Module ${index + 1}` : module.title ?? module.name ?? `Module ${index + 1}`,
    lessons: module.lessons.map(personalLesson).filter(Boolean).map(lesson => {
      keptLessons.set(lesson.id, lesson);
      add(`lesson:${lesson.id}`, {
        id: lesson.id, level: level.level, title: lesson.title, recording: filenames(lesson.source),
        duration: lesson.duration_seconds, status: lesson.status,
        sections: lesson.summary_sections.map(section => ({ text: section.text, citation: citation(section.source) })),
        objectives: lesson.objectives.map(item => ({ text: item.objective, criterion: item.success_criterion, citation: citation(item.evidence) })),
        practice: lesson.practice.map(item => ({ text: item.question, citation: citation(item.evidence) })),
      });
      return { id: lesson.id, title: lesson.title };
    }),
  })).filter(module => module.lessons.length),
}));

const answers = new Map(grades.answers.map(key => [key.item_id, key.answer_id]));
const rubrics = new Map(grades.evidence_check_rubrics.map(item => [item.item_id, item.yes_if]));
const fill = new Map(grades.proposed_fill_in_rubrics.map(item => [item.item_id, item.expected_idea]));
const evidence = new Map(links.links.map(item => [item.item_id, item.candidates.find(candidate => {
  const lesson = keptLessons.get(candidate.lesson_id);
  return lesson?.summary_sections.some(note => note.source.start_seconds < candidate.source.end_seconds &&
    note.source.end_seconds > candidate.source.start_seconds);
})]));
const titles = {
  'level-1-generated-test': 'Level 1 generated test', 'level-2-generated-test': 'Level 2 generated test',
  'level-3-training': 'Level 3 training test', 'level-4-multiple-choice': 'Level 4 primary multiple-choice test',
  'level-4-training-alternate': 'Level 4 alternate multiple-choice review', 'level-4-fill-in': 'Level 4 written and oral practice',
  'level-5-part-a-generated': 'Level 5 Part A readiness checks', 'level-5-part-b': 'Level 5 Part B',
};
const pageSize = 24;
const sets = bank.sets.map(set => {
  const items = set.items.filter(item => ![item.prompt, item.topic, ...item.choices.map(choice => choice.text),
    rubrics.get(item.id), fill.get(item.id)].some(isMarketing)).map(item => {
    const match = evidence.get(item.id);
    return {
      id: item.id, number: item.number, topic: item.topic, kind: item.kind, prompt: item.prompt,
      choices: (item.choices ?? []).map(({ id, text }) => ({ id, text })), citation: citation(item.source),
      evidence: match?.lesson_id ? { lesson: match.lesson_id, ...citation(match.source) } : undefined,
      answer: answers.get(item.id), rubric: rubrics.get(item.id) ?? fill.get(item.id),
    };
  });
  const pages = Math.ceil(items.length / pageSize);
  const filtered = items.length !== set.items.length;
  for (let page = 0; page < pages; page++) add(`set:${set.id}:${page}`, items.slice(page * pageSize, (page + 1) * pageSize));
  add(`topics:${set.id}`, [...new Set(items.map(item => item.topic).filter(Boolean))]);
  add(`order:${set.id}`, items.map(item => item.id));
  add(`pool:${set.id}`, items.flatMap((item, index) => item.answer ? [{ id: item.id, page: Math.floor(index / pageSize) }] : []));
  return {
    id: set.id, title: titles[set.id] ?? set.id, level: set.level, count: items.length, pages,
    keyed: items.filter(item => item.answer).length, generated: set.origin === 'generated_substitute', filtered,
    scoring: !filtered && requirements.level_tests[String(set.level)]?.assessment_set_id === set.id
      ? requirements.level_tests[String(set.level)] : null,
  };
});
const level5 = requirements.level_5_completion;
const index = { title: 'Success Mastery', levelIndex, sets, pageSize, status: course.status ?? 'review_required',
  advancement: requirements.advancement_to_level_5.steps.map(({ order, description }) => ({ order, description })),
  oralCriteria: requirements.advancement_to_level_5.oral_success_criteria,
  partA: level5.part_a.minimum_yes_answers, partB: level5.part_b.minimum_correct_answers, edition: 'personal-development',
};
add('index', index);
const lessonCount = levelIndex.flatMap(level => level.modules.flatMap(module => module.lessons)).length;
const questionCount = sets.reduce((sum, set) => sum + set.count, 0);
if (levelIndex.length !== 5 || levelIndex.some(level => !level.modules.length) || sets.some(set => !set.count) ||
    new Set(documents.map(item => item.id)).size !== documents.length) {
  throw new Error('The filtered course has empty levels or assessments, or duplicate IDs.');
}
const revision = createHash('sha256').update(JSON.stringify(documents)).digest('hex').slice(0, 20);
await mkdir(output, { recursive: true });
await writeFile(new URL('documents.json', output), JSON.stringify({ revision, documents }));
console.log(`Prepared ${lessonCount} lessons and ${questionCount} assessment entries across five levels. Revision ${revision}.`);
console.log(`Excluded ${sourceLessonCount - lessonCount} lessons and ${sourceQuestionCount - questionCount} assessment entries from the published edition.`);
const edited = course.levels.flatMap(level => level.modules.flatMap(module => module.lessons)).filter(lesson => {
  const kept = keptLessons.get(lesson.id);
  return kept && JSON.stringify(kept.summary_sections) !== JSON.stringify(lesson.summary_sections);
});
console.log(`Removed promotional passages from ${edited.length} retained lessons.`);
