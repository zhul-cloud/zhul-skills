---
name: gsc-confirm
description: Sweep fouwell.com's already-submitted-but-unconfirmed URLs (提交状态=已提交) through Google Search Console's URL Inspection tool to check whether Google has actually indexed them yet, updating wiki/products/GSC索引提交追踪表.md to 已确认收录 with a full timestamp for any that have. Use when the user asks to check/confirm GSC indexing status, or references "确认收录"/"GSC确认收录".
---

# gsc-confirm

Checks Google's actual indexing status (not just "submitted") for every fouwell.com URL
currently marked "已提交" in the tracking sheet — the follow-up half of the `gsc-submit`
workflow. Requesting indexing only queues a URL for crawling; only a later URL Inspection
lookup confirms whether Google actually indexed it. This skill closes that loop.

**Tracking sheet**: `/Users/mac/Documents/llm-wiki/wiki/products/GSC索引提交追踪表.md`
Columns: `URL | 类型 | 创建时间 | 上线日期 | 提交状态 | 提交日期 | 收录确认日期 | 备注`
(2026-09-14: sheet was deduped — one row per URL now. If `scripts/sync-indexing-tracker.js`
ever reintroduces duplicate rows for the same URL again, apply the same dedup rule as
`gsc-submit` before picking rows to check: a URL only needs checking if ALL its occurrences
still show 提交状态=已提交 with no 收录确认日期; skip it if any occurrence already shows
已确认收录.)

**Property**: `sc-domain:fouwell.com`, GSC account `yanglikai666@gmail.com`, via ego-browser's
"Ego Lite" browser profile — the user logs into that profile themselves, this skill never
handles credentials.

**Why this is a different shape from gsc-submit**: `gsc-submit` is throttled to one row per
~4 minutes because *clicking* "请求编入索引" burns GSC's daily indexing-request quota
(~10-12/day, unofficial community estimate). This skill never clicks that button — it only
reads the URL Inspection lookup result. So there is no reason to pace this one row per
4-minute cron firing the way `gsc-submit` does: **process pending rows inside a single run**,
looping over URLs within one (or a few, batched) ego-browser script invocation(s), with only
a short ~1s delay between lookups (not minutes).

**But URL Inspection lookups have their own, separate daily quota** (confirmed 2026-09-14,
first real run of this skill): after roughly ~48-50 consecutive lookups in one sweep, GSC
showed an `alertdialog` titled "超出了配额" with body "您已超出资源的网址检查配额。配额会
按日更新。" — a *different* quota from the indexing-request one `gsc-submit` hits, with a
much higher ceiling (~50 vs. ~10-12/day) but real nonetheless. Once it fires, the URL
Inspection combobox becomes unclickable (a blocking `<div>` intercepts pointer events) until
the dialog is closed, and inspections will keep failing until the quota resets the next day.
Do not treat that first ~48-50 as a fixed number — it's one observed data point, not a
documented limit; budget for it but confirm by watching for the dialog, not by counting.
Re-run the sweep periodically (once a day, or whenever the user asks) to catch pages that get
indexed a day or two after submission — checking immediately after submitting is usually a
wasted lookup since Google typically takes hours to days to actually index a newly-requested
URL, and each lookup now has a real (if generous) daily budget to respect.

## When invoked

1. **Open (or resume) the ego-browser task space.** Reuse an already-open taskSpace from this
   conversation if one exists on the GSC URL Inspection view; otherwise:
   ```js
   const task = await taskSpace("GSC index confirmation sweep");
   const page = task.page("p1");
   await page.goto("https://search.google.com/search-console?resource_id=sc-domain:fouwell.com");
   await page.waitForLoadState();
   console.log({ taskSpaceId: task.spaceId });
   ```
   Confirm the snapshot shows the account logged in and the "检查 fouwell.com 中的任何网址"
   combobox. If not logged in, stop and ask the user to log into the Ego Lite profile first —
   don't attempt to log in on their behalf.

2. **Read the tracking sheet fresh** and build the list of URLs to check: every row where
   提交状态 == `已提交` (submitted, not yet confirmed). Dedup by URL per the rule above.

3. **No pending rows** → reply briefly that there's nothing left to confirm right now (either
   everything is already 已确认收录, or nothing has been submitted yet), and stop.

4. **For each pending URL, in order, inside the running script** (no per-row cron pacing —
   see rationale above; batch roughly 15-20 URLs per `ego-browser nodejs` invocation — not
   more, given the ~48-50/day lookup quota discovered above — and run multiple invocations
   back to back if the list is long, checkpointing the table between invocations):
   - Click the URL-inspection combobox, type the URL, press Enter, wait ~2-3s, then:
     ```js
     await page.waitForFunction(
       () => !document.body.innerText.includes('正在从 Google 索引检索数据'),
       undefined, { timeout: 60000 }
     );
     ```
   - **"网址已收录到 Google" appears** → confirmed indexed. Record it (e.g. push to an array)
     for the table update in step 5 — don't write the file mid-loop, batch the writes after.
   - **"网址尚未收录到 Google" appears** → not indexed yet. Leave the row untouched — do NOT
     write anything for it, it stays `已提交` for a future sweep. Move to the next URL.
   - **Quota dialog** (`alertdialog` titled "超出了配额", body "您已超出资源的网址检查配额。
     配额会按日更新。") appears instead: this is the URL Inspection quota, not the indexing-
     request one — close the dialog, stop the loop immediately (further clicks are blocked by
     the dialog's overlay anyway — a `<div>` intercepts pointer events until it's closed), and
     go straight to step 5 with whatever confirmations were already collected before the quota
     hit. Report to the user how many were confirmed this run and that the *lookup* quota (not
     the submission one) was hit — it resets daily, resume the sweep later or tomorrow.
   - **Other unexpected state** (a different error dialog, not logged in, page failed to load)
     → stop the loop for this invocation, keep whatever confirmations were already collected,
     and report what broke rather than guessing.
   - A short `waitForTimeout(800-1500)` between URLs is enough — just avoids hammering the UI
     or racing the lookup dialog.

5. **Update the tracking table** in one batched pass after each script invocation (not once
   per URL) for every URL that came back indexed in step 4:
   - `grep -n "<url>"` to find its line number (should be exactly one, post-dedup; if more
     than one somehow, update only the first/lowest-numbered occurrence, per `gsc-submit`'s
     convention).
   - Set 提交状态 = `已确认收录`, 收录确认日期 = current full timestamp
     (`YYYY-MM-DD HH:MM:SS`, resolved at run time — never hardcode a date). Leave 提交日期
     exactly as it already was (don't touch it). Append to 备注 — don't overwrite — something
     like `确认收录（自动核查，ego-browser）`; if 备注 already has submission-time content,
     keep it and append this after a `；` separator.
   - Do this via a targeted Python script that reads the file, rewrites only the located
     line(s), and writes it back — never the `Edit` tool (fails on duplicate/near-duplicate
     lines, which this table has had before).

6. **Optional recurring sweep**: only if the user asks for this to run automatically going
   forward (not just once), offer `CronCreate` with a spaced-out interval — e.g. once every
   few hours or once a day (`cron: "0 */6 * * *"` or similar) — since indexing takes hours to
   days to land after submission, not minutes. Do not create a recurring job unless asked; a
   one-off sweep is the default behavior.

7. **Report tersely**: how many URLs were checked this run, how many came back newly
   confirmed (list a few, or just the count if many), and how many are still pending
   indexing (count only).

## Known pitfalls

- Don't reuse `gsc-submit`'s one-row-per-4-minute cron pacing here — that pacing exists to
  protect the *submission* quota, which this skill never touches. Pacing this the same way
  would make a same-day sweep take hours for no reason.
- Don't assume URL Inspection lookups are quota-free just because they don't click "请求编入
  索引" — they have their own daily quota (~48-50/day observed 2026-09-14), separate from and
  much larger than the indexing-request quota, but real. Batch in chunks of ~15-20 and watch
  for the "超出了配额" alertdialog rather than assuming unlimited lookups.
- Don't mark a URL `已确认收录` on a "尚未收录" result — leave 提交状态 untouched and just
  skip it. Confirmation only happens on genuine "已收录" evidence, per the tracking sheet's
  own SOP (维护流程 step 5): don't skip straight to 已确认收录 without real verification.
- Full-timestamp dates (`YYYY-MM-DD HH:MM:SS`) are the format from 2026-09-14 onward for both
  提交日期 (set by `gsc-submit`) and 收录确认日期 (set by this skill) — older rows in the
  sheet may still hold date-only values from before this change; leave those as-is, don't
  rewrite history.
- Don't touch 提交日期 in this skill at all — it belongs to `gsc-submit` and should never be
  overwritten by a confirmation check.
