# Class manifest (`daily.class-manifest/1`)

One JSON block per course that Daily imports in one paste: lectures, readings and
problem sets become **sources** in the course's notebook; anything with a `date`
becomes a **deadline** with a "start by" day that lands on the daily list.

Where to paste it: Learn → open the course's notebook → Sources → **Import class manifest**.

## Schema

```json
{
  "schema": "daily.class-manifest/1",
  "course": "ECON 201",
  "term": "Fall 2026",
  "items": [
    { "kind": "syllabus",    "title": "Syllabus", "text": "…full syllabus text…", "url": "https://rutgers.instructure.com/courses/…/files/…" },
    { "kind": "lecture",     "title": "Week 2 — Supply and demand", "week": 2, "text": "…slide text…" },
    { "kind": "reading",     "title": "Mankiw ch. 4", "week": 2, "url": "https://…", "text": "…" },
    { "kind": "problem_set", "title": "Problem Set 1", "week": 3, "date": "2026-09-18", "points": 20, "url": "https://…" },
    { "kind": "past_exam",   "title": "Midterm 1 — Fall 2025", "url": "https://…" },
    { "kind": "rubric",      "title": "Essay rubric", "text": "…" },
    { "kind": "deadline",    "title": "Midterm 1", "date": "2026-10-09", "url": "https://…" }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `schema` | yes | exactly `"daily.class-manifest/1"` — anything else is refused |
| `course` | yes | the course code as Canvas shows it (`"ECON 201"`, `"ECON 201-01"`, `"01:220:102:01"` all map to the same course key) |
| `term` | no | free text, kept for the record |
| `items[].kind` | yes | one of `syllabus` · `lecture` · `reading` · `problem_set` · `past_exam` · `rubric` · `deadline` |
| `items[].title` | yes | short, as Canvas names it |
| `items[].week` | no | class week 1–20; class notebooks order chapters by it |
| `items[].date` | no | `YYYY-MM-DD`; **any item with a date becomes a deadline**, due at the end of that day |
| `items[].text` | no | the material itself — paste it when it is under ~200k characters |
| `items[].url` | no | the Canvas URL (kept as a link; for a large PDF this is what Ben uploads by hand) |
| `items[].points` | no | number, shown on the deadline |

### What happens on import

- Every item whose kind is a learning kind (`syllabus`, `lecture`, `reading`, `problem_set`, `past_exam`, `rubric`) **and** has `text` or `url` becomes a `notebook_sources` row: kind `note` (or `link` when there is only a url), `week` set, `meta = { kind, week }`. The database chunks the text into passages on insert.
- Every item with a `date` becomes a `deadlines` row with `source = 'syllabus'`, linked to this notebook. Its deadline kind comes from the title (midterm/final/exam → exam; quiz → quiz; discussion; reading; problem set/homework/assignment/essay/paper/project → assignment; else the manifest kind's fallback: reading → reading, problem_set → assignment, otherwise other). "Start by" = due minus lead days (exam 7 · essay/paper/project 5 · assignment 3 · quiz 2 · reading/discussion 1 · other 2).
- After the deadlines save, `mirror_deadline_goals` runs so each one gets a goal that appears on the daily list on its start-by day.
- If the notebook has no course code yet, the manifest's `course` is written to it, so Canvas-synced deadlines for the same course link to it automatically.
- Re-importing the same manifest updates the deadlines instead of duplicating them (see the uid rule). Sources are always added — remove the old ones first if you re-import material.

### The uid rule (`deadlines.uid` for syllabus rows)

```
uid = "syl-" + hex8( FNV-1a-32( lower(collapse_ws(course)) + "|" + lower(collapse_ws(title)) + "|" + date ) )
```

- `collapse_ws` trims and collapses runs of whitespace to one space; `date` is the `YYYY-MM-DD` string as given.
- FNV-1a 32-bit: `h = 0x811c9dc5; for each UTF-16 code unit c: h ^= c; h = (h * 0x01000193) mod 2^32`; render as 8 lower-case hex digits.
- Implemented client-side as `manifestUid()` in `src/components/NotebookSources.tsx`. Unique per `(user_id, source, uid)`, so the same course + title + date always lands on the same row.

## Audit prompt for Claude in Chrome

Run it **one course at a time** with the course's Canvas page open. Paste the whole thing.

```
You are auditing ONE Canvas course for me and producing ONE JSON block I will paste into my study app. Do not summarise, do not skip sections, do not write anything but the final JSON at the end.

Course: [COURSE CODE, e.g. ECON 201]   Term: [e.g. Fall 2026]

Walk these four places in order, scrolling to the bottom of each and opening every expandable module:
1. Modules — every page, file, and link in every module. Note the module's week number if the module name or dates make it obvious.
2. Files — every file, especially PDFs (slides, readings, problem sets, past exams, rubrics).
3. Assignments — every assignment, quiz, discussion and exam, with its due date and points.
4. Syllabus — the syllabus page and any attached syllabus PDF; the schedule table inside it usually has the week-by-week topics and readings.

For each thing you find, make one item:
- kind: "syllabus" | "lecture" | "reading" | "problem_set" | "past_exam" | "rubric" | "deadline"
- title: as Canvas names it
- week: the class week (integer) when you can tell, else omit
- date: "YYYY-MM-DD" for anything with a due date (assignments, quizzes, exams, discussions, dated readings). Every graded thing must carry its date. If Canvas shows only "Sep 18", use the term's year.
- points: the point value when shown
- url: the Canvas URL of the page or file
- text: the full text when it is a Canvas page or a small file you can open and read (under about 200,000 characters). For big PDFs (slide decks, textbook chapters) DO NOT paste the text — leave text out, keep the url, and add the file to the "upload_by_hand" list at the end so I can upload it myself.

Rules:
- A due date that also has material (e.g. a problem set PDF) is ONE item with both a date and a url/text — do not split it.
- Exams are kind "deadline" with a date; the exam's study guide or past exam is a separate "past_exam" or "reading" item.
- Never invent a date. If you can't find one, omit "date".
- Keep going until every section is exhausted. If something needs a click to open, click it.

Output exactly this, as the last thing you write, with nothing after it:

{
  "schema": "daily.class-manifest/1",
  "course": "[COURSE CODE]",
  "term": "[TERM]",
  "items": [ ... ],
  "upload_by_hand": [ { "title": "...", "url": "https://..." } ]
}
```

`upload_by_hand` is ignored by the importer — it is the list of big PDFs for Ben to
add through Sources → 📄 PDF, which extracts the text server-side with page markers.
