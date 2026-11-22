import { takeLessonReminder } from './reminders.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, style = 'secondary') {
  const node = element('button', text, style);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function timestamp(seconds) {
  const value = Math.floor(seconds);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

function reference(citation) {
  const location = citation?.page ? `page ${citation.page}` : Number.isFinite(citation?.start)
    ? `${timestamp(citation.start)}–${timestamp(citation.end)}` : '';
  return element('p', [citation?.source, location].filter(Boolean).join(' · '), 'course-citation');
}

function localDay() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, '0')).join('-');
}

export async function mountCourseLibrary(root, request, chooseCoachLesson) {
  const heading = element('h2', 'Success Mastery');
  heading.id = 'course-title';
  const toolbar = element('div', '', 'course-toolbar');
  const panel = element('div');
  const status = element('p', 'Loading the course…', 'status');
  status.setAttribute('role', 'status');
  root.replaceChildren(heading, toolbar, status, panel);
  root.hidden = false;

  const get = values => request('/api/course?' + new URLSearchParams(values));
  const save = values => request('/api/course', values);
  let revision;
  let index;
  let studied;
  let selected = 1;
  let lastLessonId;
  try { selected = Number(localStorage.getItem('coach:course-level')) || 1; } catch { /* Use Level 1 when storage is unavailable. */ }
  let navigation = 0;
  let writing = false;

  async function navigate(fetchView, show) {
    if (writing) return;
    const sequence = ++navigation;
    status.textContent = 'Loading…';
    try {
      const view = await fetchView();
      if (sequence !== navigation) return;
      status.textContent = '';
      return await show(view);
    } catch (error) {
      if (sequence === navigation) status.textContent = error.message;
    }
  }

  async function write(control, action) {
    if (writing) return;
    writing = true;
    control.disabled = true;
    status.textContent = 'Saving…';
    try {
      await action();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      writing = false;
      control.disabled = false;
      openFromReminder();
    }
  }

  function currentLevel() {
    return index.levelIndex.find(level => level.level === selected);
  }

  function openLevel() {
    if (writing) return;
    ++navigation;
    status.textContent = '';
    const level = currentLevel();
    const lessons = level.modules.flatMap(module => module.lessons);
    const label = element('h3', `Level ${selected}`);
    const progress = element('p', `${lessons.filter(item => studied.has(item.id)).length} of ${lessons.length} lessons studied`, 'muted');
    const sets = element('ul', '', 'course-list');
    for (const set of index.sets.filter(set => set.level === selected)) {
      const row = element('li');
      row.append(button(`${set.title} · ${set.count} items`, () => openAssessment({ view: 'assessment', set: set.id }), 'link'));
      sets.append(row);
    }
    panel.replaceChildren(label, progress, element('h3', 'Assessments'), sets, element('h3', 'Lessons'));
    for (const module of level.modules) {
      const group = element('details', '', 'course-module');
      group.append(element('summary', `${module.title} · ${module.lessons.length} lessons`));
      const list = element('ul', '', 'course-list');
      for (const lesson of module.lessons) {
        const row = element('li');
        row.append(button(lesson.title, () => openLesson(lesson.id), 'link'));
        if (studied.has(lesson.id)) row.append(' · Studied');
        list.append(row);
      }
      group.append(list);
      panel.append(group);
    }
    const progression = element('details', '', 'course-module');
    const steps = element('ol', '', 'course-list');
    for (const step of index.advancement) steps.append(element('li', step.description));
    progression.append(element('summary', 'Mastery and advancement requirements'),
      element('p', 'Level 5 follows the Level 4 review and oral assessment.'), steps,
      element('p', index.edition === 'personal-development'
        ? `The original Level 5 requirements were ${index.partA} evidenced Yes answers in Part A and ${index.partB} correct answers on the full Part B test. The personal-development edition uses the retained questions for practice.`
        : `Level 5 requires ${index.partA} evidenced Yes answers in Part A and ${index.partB} correct answers in Part B.`),
      element('p', 'Study progress and practice scores are saved here. Oral and readiness evidence requires review before mastery sign-off.'));
    panel.append(progression);
  }

  function openRandomLesson(unstudiedOnly = false) {
    if (writing) return;
    const lessons = currentLevel().modules.flatMap(module => module.lessons);
    const candidates = unstudiedOnly ? lessons.filter(lesson => !studied.has(lesson.id)) : lessons;
    if (!candidates.length) {
      if (unstudiedOnly) openLevel();
      status.textContent = lessons.length ? `All lessons in Level ${selected} are marked studied.` : 'No lessons are available in this level.';
      return;
    }
    const different = candidates.filter(lesson => lesson.id !== lastLessonId);
    const available = different.length ? different : candidates;
    const unstudied = available.filter(lesson => !studied.has(lesson.id));
    const choices = unstudied.length ? unstudied : available;
    return openLesson(choices[Math.floor(Math.random() * choices.length)].id, true);
  }

  function openFromReminder(refresh = true) {
    if (writing || !takeLessonReminder()) return;
    if (!refresh) return openRandomLesson(true);
    return navigate(() => get({ view: 'index' }), data => {
      revision = data.revision;
      studied = new Set(data.studied);
      return openRandomLesson(true);
    });
  }

  function openLesson(id, focusTitle = false) {
    return navigate(() => get({ view: 'lesson', id }), ({ lesson }) => {
      lastLessonId = id;
      const title = element('h3', lesson.title);
      panel.replaceChildren(button('Level overview', openLevel), title);
      panel.append(button('Ask the coach about this lesson', () => chooseCoachLesson({ id, title: lesson.title, revision }), 'primary'));
      panel.append(element('p', 'Recording notes for review', 'muted'));
      if (!lesson.sections.length) panel.append(element('p', 'This recording’s summary needs review.'));
      for (const section of lesson.sections) {
        const row = element('div', '', 'course-section');
        row.append(element('p', section.text), reference(section.citation));
        panel.append(row);
      }
      for (const [title, items] of [['Learning objectives', lesson.objectives], ['Practice prompts', lesson.practice]]) {
        if (!items.length) continue;
        const list = element('ul', '', 'course-list');
        for (const item of items) {
          const row = element('li', item.text);
          if (item.criterion) row.append(element('p', item.criterion));
          row.append(reference(item.citation));
          list.append(row);
        }
        panel.append(element('h3', title), list);
      }
      const mark = button(studied.has(id) ? 'Studied' : 'Mark studied', () => write(mark, async () => {
        if (studied.has(id)) return;
        await save({ view: 'lesson', id, revision });
        studied.add(id);
        mark.textContent = 'Studied';
        status.textContent = 'Lesson progress saved.';
      }), 'primary');
      panel.append(mark);
      if (focusTitle) {
        title.tabIndex = -1;
        title.focus();
      }
    });
  }

  function openAssessment(params, slot) {
    return navigate(() => get(params), view => {
      const answered = new Map(view.activity.map(row => [row.item_id, row]));
      const next = view.items.findIndex(item => !answered.has(item.id));
      renderAssessment(params, view, answered, slot ?? Math.max(next, 0));
    });
  }

  function renderAssessment(params, view, answered, slot) {
    const { set, page, items, topics } = view;
    const item = items[slot];
    const saved = answered.get(item.id);
    const correct = [...answered.values()].filter(row => row.correct === true);
    const pending = [...answered.values()].filter(row => row.correct === null).length;
    const coverage = new Set(correct.map(row => row.topic));
    const criteria = set.scoring && correct.length >= set.scoring.minimum_correct_answers && topics.every(topic => coverage.has(topic));
    const position = page * index.pageSize + slot + 1;
    panel.replaceChildren(button('Level overview', openLevel), element('h3', set.title),
      element('p', `${answered.size} of ${set.count} answered · ${correct.length} correct · ${pending} for review`, 'muted'));
    if (criteria) panel.append(element('p', 'Generated practice threshold met.'));
    if (set.scoring) panel.append(element('p', `Target ${set.scoring.minimum_correct_answers} correct, with at least one correct per topic.`));
    if (set.id === 'level-5-part-b' && params.view === 'assessment') {
      panel.append(element('p', set.filtered ? 'Personal-development practice from the original Part B test.' : `Part B target ${index.partB} correct.`));
    }
    const form = element('form');
    const group = element('fieldset');
    group.append(element('legend', `${position} of ${set.count}. ${item.prompt}`));
    if (item.kind === 'multiple_choice') {
      for (const option of item.choices) {
        const label = element('label', '', 'choice');
        const input = element('input');
        Object.assign(input, { type: 'radio', name: 'answer', value: option.id, checked: saved?.response === option.id, required: true });
        label.append(input, element('span', option.text));
        group.append(label);
      }
    } else {
      const label = element('label', item.kind === 'evidence_check' ? 'Your example or evidence' : 'Your written answer or oral practice notes');
      const input = element('textarea');
      Object.assign(input, { name: 'answer', required: true, maxLength: 1200, value: saved?.response ?? '' });
      label.append(input);
      group.append(label);
    }
    const result = element('p', saved ? saved.correct === null ? 'Saved for review.' : saved.correct ? 'Correct.' : 'Try reviewing the source.' : '', 'status');
    result.setAttribute('role', 'status');
    const submit = element('button', 'Save answer', 'primary');
    form.append(group, submit, result);
    form.addEventListener('submit', event => {
      event.preventDefault();
      return write(submit, async () => {
        const answer = new FormData(form).get('answer');
        const row = await save({ ...params, page, revision, id: item.id, answer });
        answered.set(item.id, row);
        renderAssessment(params, view, answered, slot);
        status.textContent = row.reviewCriterion ? `Saved for review. Criterion: ${row.reviewCriterion}` : 'Answer synced.';
        panel.querySelector('legend').tabIndex = -1;
        panel.querySelector('legend').focus();
      });
    });
    panel.append(form, reference(item.citation));
    if (item.evidence?.lesson) panel.append(button('Review linked lesson', () => openLesson(item.evidence.lesson), 'link'));
    const navigation = element('div', '', 'course-actions');
    const previous = button('Previous question', () => {
      if (writing) return;
      if (slot > 0) renderAssessment(params, view, answered, slot - 1);
      else openAssessment({ ...params, page: page - 1 }, index.pageSize - 1);
    });
    previous.disabled = position <= 1;
    const next = button('Next question', () => {
      if (writing) return;
      if (slot + 1 < items.length) renderAssessment(params, view, answered, slot + 1);
      else openAssessment({ ...params, page: page + 1 }, 0);
    });
    next.disabled = position >= set.count;
    navigation.append(previous, next);
    if (set.count > 3) {
      const jump = element('form', '', 'course-actions');
      const label = element('label', 'Question number');
      const number = element('input');
      Object.assign(number, { type: 'number', min: 1, max: set.count, value: position, required: true });
      label.append(number);
      jump.append(label, element('button', 'Go', 'secondary'));
      jump.addEventListener('submit', event => {
        event.preventDefault();
        const offset = number.valueAsNumber - 1;
        openAssessment({ ...params, page: Math.floor(offset / index.pageSize) }, offset % index.pageSize);
      });
      navigation.append(jump);
    }
    panel.append(navigation);
  }

  try {
    ({ revision, index, studied } = await get({ view: 'index' }));
    studied = new Set(studied);
    if (!index.levelIndex.some(level => level.level === selected)) selected = 1;
    const label = element('label', 'Course level');
    label.htmlFor = 'course-level';
    const levels = element('select');
    levels.id = 'course-level';
    for (const { level } of index.levelIndex) levels.append(new Option(`Level ${level}`, String(level)));
    levels.value = String(selected);
    levels.addEventListener('change', () => {
      if (writing) { levels.value = String(selected); return; }
      selected = Number(levels.value);
      try { localStorage.setItem('coach:course-level', String(selected)); } catch { /* Continue at the selected level in this tab. */ }
      openLevel();
    });
    const coach = element('a', 'Voice practice', 'link');
    coach.href = '#coach-title';
    const daily = () => openAssessment({ view: 'daily', level: selected, day: localDay() });
    toolbar.append(label, levels, button('Daily practice', daily, 'primary'), button('Random lesson', () => openRandomLesson()), coach);
    openLevel();
    window.addEventListener('coach-open-reminder', () => openFromReminder());
    await openFromReminder(false);
  } catch (error) {
    status.textContent = error.message;
  }
}
