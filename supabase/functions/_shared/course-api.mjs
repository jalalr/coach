import { json, synthesizeSpeech } from './coach-api.mjs';

export const dailySets = ['level-1-generated-test', 'level-2-generated-test', 'level-3-training', 'level-4-multiple-choice', 'level-5-part-b'];
const commonWords = new Set(['about', 'what', 'where', 'which', 'when', 'could', 'would', 'should', 'this', 'that', 'with', 'from', 'have', 'does', 'tell', 'lesson', 'recording', 'please']);
const terms = value => new Set((value.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => !commonWords.has(word)));

export function createCourseApi({ supabaseUrl, serviceKey, getVoiceKey }) {
  if (!serviceKey) return null;
  const cache = new Map();
  const headers = { apikey: serviceKey, ...(!serviceKey.startsWith('sb_secret_') && { Authorization: `Bearer ${serviceKey}` }) };

  async function database(table, params, body) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams(params)}`, {
      headers: { ...headers, ...(body && { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }) },
      method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Course database request failed');
    }
    return response.json();
  }

  async function document(revision, id) {
    const key = `${revision}/${id}`;
    if (revision !== 'published' && cache.has(key)) return cache.get(key);
    const [row] = await database('coach_course_documents', {
      revision: `eq.${revision}`, document_id: `eq.${id}`, select: 'payload', limit: 1,
    });
    if (row && revision !== 'published') {
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, row.payload);
    }
    return row?.payload;
  }

  function activity(userId, revision, section) {
    return database('coach_course_activity', {
      user_id: `eq.${userId}`, revision: `eq.${revision}`, section: `eq.${section}`,
      select: 'item_id,response,correct,topic', limit: 1000,
    });
  }

  async function save(userId, revision, section, item, answer) {
    const correct = item.answer ? answer === item.answer : null;
    const [row] = await database('coach_course_activity', {}, {
      user_id: userId, revision, section, item_id: item.id, response: answer, correct,
      topic: item.topic ?? null, updated_at: new Date().toISOString(),
    });
    return { item_id: row.item_id, response: row.response, correct: row.correct, topic: row.topic,
      reviewCriterion: correct === null ? item.rubric : undefined };
  }

  function publicQuestion({ answer, rubric, ...item }) {
    return item;
  }

  async function lessonVoice(lesson, value) {
    if (value.view === 'read') {
      if (!Number.isInteger(value.section) || !lesson.sections[value.section]) return json(404, { error: 'Recording note unavailable.' });
      try {
        const audio = await synthesizeSpeech(getVoiceKey(), lesson.sections[value.section].text.slice(0, 1500));
        if (!audio) return json(503, { error: 'Read-aloud is unavailable.' });
        return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
      } catch {
        return json(502, { error: 'The voice service could not read the note. Try again.' });
      }
    }
    if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 350) return json(400, { error: 'Enter a question about this lesson.' });
    const query = terms(value.question);
    const matches = lesson.sections.map((section, index) => ({ section, index,
      matches: [...terms(section.text)].filter(word => query.has(word)).length }));
    matches.sort((left, right) => right.matches - left.matches);
    const selected = matches[0];
    if (!selected || (!selected.matches && !/summari[sz]e|overview|main idea|what.*about/i.test(value.question))) {
      return json(200, { reply: 'I couldn’t find a matching note in this recording. Try naming a concept from the lesson or ask for an overview.' });
    }
    return json(200, { reply: selected.section.text, citation: selected.section.citation, section: selected.index });
  }

  async function assessment(revision, index, view, value) {
    if (view === 'assessment') {
      const set = index.sets.find(set => set.id === value.set);
      const page = Number(value.page ?? 0);
      if (!set || !Number.isInteger(page) || page < 0 || page >= set.pages) return null;
      const [items, topics] = await Promise.all([document(revision, `set:${set.id}:${page}`), document(revision, `topics:${set.id}`)]);
      return { set, page, items, topics, section: set.id };
    }
    if (view !== 'daily' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day ?? '')) return null;
    const date = new Date(value.day);
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value.day) return null;
    const level = Number(value.level);
    if (!Number.isInteger(level) || level < 1 || level > dailySets.length) return null;
    const set = index.sets.find(set => set.id === dailySets[level - 1]);
    const pool = await document(revision, `pool:${set.id}`);
    const offset = ((Math.floor(+date / 86400000) * 3) % pool.length + pool.length) % pool.length;
    const refs = Array.from({ length: Math.min(3, pool.length) }, (_, index) => pool[(offset + index) % pool.length]);
    const items = await Promise.all(refs.map(async ({ id, page }) =>
      (await document(revision, `set:${set.id}:${page}`)).find(item => item.id === id)));
    return { set: { ...set, title: `Level ${level} daily practice`, count: items.length, keyed: items.length, pages: 1, scoring: null },
      page: 0, items, topics: [], section: `daily:${level}:${value.day}` };
  }

  return async function handle(method, url, body, userId) {
    try {
      const { revision } = await document('published', 'active') ?? {};
      if (!revision) return json(503, { error: 'The full course is awaiting import.' });
      const value = method === 'GET' ? Object.fromEntries(url.searchParams) : body ?? {};
      if (method === 'POST' && value.revision !== revision) return json(409, { error: 'The course has been updated. Reload before submitting.' });
      const { view, id } = value;
      if (method === 'POST' && ['ask', 'read'].includes(view) && /^[0-9a-f]{16}$/.test(id ?? '')) {
        const lesson = await document(revision, `lesson:${id}`);
        return lesson ? lessonVoice(lesson, value) : json(404, { error: 'Lesson unavailable.' });
      }
      if (view === 'lesson' && /^[0-9a-f]{16}$/.test(id ?? '')) {
        const lesson = await document(revision, `lesson:${id}`);
        if (!lesson) return json(404, { error: 'Lesson unavailable.' });
        if (method === 'GET') return json(200, { revision, lesson });
        return json(200, await save(userId, revision, 'lessons', { id }, 'studied'));
      }

      const index = await document(revision, 'index');
      if (method === 'GET' && view === 'index') {
        const studied = (await activity(userId, revision, 'lessons')).map(row => row.item_id);
        return json(200, { revision, index, studied });
      }
      let existing;
      if (method === 'GET' && view === 'assessment' && value.page === undefined && index.sets.some(set => set.id === value.set)) {
        const [rows, order] = await Promise.all([activity(userId, revision, value.set), document(revision, `order:${value.set}`)]);
        existing = rows;
        const saved = new Set(rows.map(row => row.item_id));
        const firstUnanswered = order?.findIndex(id => !saved.has(id)) ?? 0;
        value.page = Math.floor(Math.max(0, firstUnanswered) / index.pageSize);
      }
      const selected = await assessment(revision, index, view, value);
      if (!selected) return json(404, { error: 'Assessment unavailable.' });
      if (method === 'GET') {
        return json(200, { revision, ...selected, items: selected.items.map(publicQuestion),
          activity: existing ?? await activity(userId, revision, selected.section) });
      }
      const item = selected.items.find(item => item.id === id);
      const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
      const valid = item?.kind === 'multiple_choice' ? item.choices.some(choice => choice.id === answer) : answer.length > 0 && answer.length <= 3000;
      if (!item || !valid) return json(400, { error: 'Enter a valid response for this question.' });
      return json(200, await save(userId, revision, selected.section, item, answer));
    } catch {
      return json(502, { error: 'Could not load or save your course. Try again.' });
    }
  };
}
