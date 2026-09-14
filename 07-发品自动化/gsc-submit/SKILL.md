---
name: gsc-submit
description: Auto-submit fouwell.com's remaining unsubmitted URLs to Google Search Console for indexing, paced every ~4 minutes via ego-browser, updating wiki/products/GSC索引提交追踪表.md as each one confirms. Use when the user asks to run/resume/continue GSC index submission, or references the "GSC索引提交追踪表"/index submission automation.
---

# gsc-submit

Drives Google Search Console's URL Inspection tool through ego-browser to request indexing
for fouwell.com pages still marked "未提交" in the tracking sheet, one URL every ~4 minutes,
updating the sheet as it goes. Built from a manual workflow run repeatedly in-session on
2026-09-12/13 — this packages that into a repeatable trigger.

**Tracking sheet**: `/Users/mac/Documents/llm-wiki/wiki/products/GSC索引提交追踪表.md`
Columns: `URL | 类型 | 创建时间 | 上线日期 | 提交状态 | 提交日期 | 收录确认日期 | 备注`
Its own "维护流程" section documents the underlying SOP (priority order, the ~10-12/day
unofficial community-estimated quota, why this can't be a pure API call — Google's Indexing
API is restricted to JobPosting/BroadcastEvent content, doesn't cover product/hub pages).
Read that section once at the start of a fresh run for the full rationale; this skill only
covers the automation mechanics.

**2026-09-14: date format change.** 提交日期 and 收录确认日期 now use a full timestamp
`YYYY-MM-DD HH:MM:SS` (e.g. `2026-09-14 15:32:07`), not just a date — resolve the real
current date-time at write time, never hardcode one. Older rows written before this change
may still hold date-only values; leave those as-is, don't rewrite history. (The sheet was
also deduped on 2026-09-14 — one row per URL now. See `gsc-confirm` for the companion skill
that checks whether "已提交" rows have actually been indexed yet.)

**Property**: `sc-domain:fouwell.com`, GSC account `yanglikai666@gmail.com`, via ego-browser's
"Ego Lite" browser profile — the user logs into that profile themselves (real browser
session), this skill never handles credentials.

## When invoked

1. **Check for an already-running job first.** Call `CronList`. If a job matching this
   skill's recurring prompt already exists, don't create a duplicate — tell the user it's
   already running (with its next-fire cadence) and stop, unless they explicitly ask to
   restart it (in which case `CronDelete` the old one first).

2. **Open (or resume) the ego-browser task space.**
   - If a taskSpace from a prior turn in *this same conversation* is already open on the GSC
     URL Inspection view (check recent context), reuse its `spaceId`.
   - Otherwise start fresh:
     ```js
     const task = await taskSpace("GSC index submission automation");
     const page = task.page("p1");
     await page.goto("https://search.google.com/search-console?resource_id=sc-domain:fouwell.com");
     await page.waitForLoadState();
     console.log({ taskSpaceId: task.spaceId });
     ```
   - Confirm the snapshot shows the user's Google account logged in and the "检查 fouwell.com
     中的任何网址" combobox. If not logged in, stop and ask the user to log into the Ego Lite
     profile first (don't attempt to log in on their behalf).
   - Note the `spaceId` — it gets baked into the recurring cron prompt below.

3. **Do one submission immediately** (don't wait for the first cron fire) so the user sees
   an immediate result, following the exact per-URL procedure in "Per-URL procedure" below.

4. **Schedule the recurring job** with `CronCreate`, `cron: "*/4 * * * *"`, `recurring: true`,
   and a `prompt` that is a **self-contained copy of "Per-URL procedure + stop conditions"
   below**, with the real `spaceId` from step 2 substituted in. The prompt must NOT contain a
   literal hardcoded date anywhere — always tell it to use the actual current date at fire
   time (dates roll over across a multi-day run; a hardcoded date was a real bug caught in
   an earlier run of this workflow).

5. Report back tersely: what the first submission did, and that the recurring job is now
   scheduled (mention its ~4 min cadence and that it self-stops on completion or quota limit).

## Per-URL procedure (used both for the immediate first submission and inside the cron prompt)

Process exactly **one** tracking-sheet row per invocation — pacing comes from the cron
interval, not from looping inside one firing.

1. Read the tracking sheet. Find the first row still marked "未提交" in 提交状态 (row order
   already reflects the sheet's own SOP priority: 型号页/Hub pages before 核心页面).
2. **No pending rows left** → reply briefly that everything's submitted, `CronDelete` this
   job (use `CronList` to find its id if not already known), stop.
3. Resume the browser (`taskSpace(<id>)`, `page("p1")`). Take a snapshot first — refs shift
   between pages — then click the URL-inspection combobox, type the pending URL, press
   Enter, wait ~5s, and read the inspection result. If the initial lookup is still loading
   (dialog "正在从 Google 索引检索数据"), wait it out the same way as step 5's dialogs before
   reading the result — don't assume 5s is always enough.
4. **Already indexed** ("网址已收录到 Google" appears): skip requesting indexing entirely —
   update the row directly: 提交状态 = `已确认收录`, 收录确认日期 = current full timestamp
   (`YYYY-MM-DD HH:MM:SS`), 备注 = `自然抓取已收录，未手动提交（自动核查，ego-browser）`.
5. **Not yet indexed**: click "请求编入索引" / "请求编入索引再次提交请求". Then wait out
   **both** possible progress-dialog texts before checking the result — GSC shows either
   "正在测试实际网址可否编入索引" or "正在提交请求" (sometimes both in sequence) — e.g.:
   ```js
   await page.waitForFunction(
     () => !document.body.innerText.includes('正在测试') && !document.body.innerText.includes('正在提交请求'),
     undefined, { timeout: 120000 }
   );
   ```
   (Checking for only one of the two strings was a real bug in an earlier version of this
   automation — it let the script read a false "success" state mid-submission.) If a
   viewport-scoped snapshot (`{ scope: "only_within_viewport" }`) shows neither dialog text
   nor the success dialog after the wait resolves, take one `{ scope: "full_page" }` snapshot
   before concluding something went wrong — the "已请求编入索引" confirmation dialog has been
   observed rendering outside the current viewport snapshot at least once even though it was
   genuinely present in the DOM.
   - **Success** ("已请求编入索引" dialog): close it, update the row — 提交状态 = `已提交`,
     提交日期 = current full timestamp (`YYYY-MM-DD HH:MM:SS`), 备注 = `自动提交
     （ego-browser）` (append, don't overwrite, if 备注 already has content).
   - **Quota/rate-limit or unexpected state** (an error dialog, quota message, or the request
     button missing/disabled): do NOT touch the tracking row. `CronDelete` this job. Tell the
     user plainly: hit what looks like GSC's daily indexing-request limit (per the tracking
     sheet's SOP, ~10-12/day, unofficial estimate), how many rows this run processed, and
     that they can re-invoke this skill tomorrow (or ask to resume) once the quota resets.
6. Leave the browser task space open between rows (no `task.finish()`) — the next cron
   firing, or the next skill invocation, reuses it.

## Known pitfalls (already fixed once, don't reintroduce)

- Don't hardcode a date anywhere in the cron prompt — always resolve "today" at fire time.
- Wait out all three known transient dialog texts before reading a result: "正在从 Google
  索引检索数据" (initial lookup, step 3), and "正在测试实际网址可否编入索引" /
  "正在提交请求" (submission, step 5). Checking for only one at a time is insufficient —
  they can appear in sequence, and a check that runs between two of them will falsely see
  "no dialog" and read a stale/incomplete state.
- Don't skip the "already indexed" check (step 4) — a real fraction of hub/brand pages get
  indexed by natural crawl before anyone manually requests it, and re-submitting them wastes
  quota for no benefit.
- This is a `CronCreate` job: session-only (dies if the Claude session ends) and
  auto-expires after 7 days. If the user comes back in a new session wanting to resume, just
  re-invoke this skill — it creates a fresh taskSpace and a fresh cron job from scratch.
