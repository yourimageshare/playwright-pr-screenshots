// Playwright and Cypress failure screenshots in PR comments (YourImageShare). No dependencies: Node 24 has fetch, FormData and Blob.
// Finds the screenshots of failed tests, uploads them to YourImageShare, and writes one pull request comment (updated on every
// run) plus the job summary. It never fails your build: problems are reported as warnings.
import fs from 'node:fs';
import path from 'node:path';

const MARK = 'yourimageshare-playwright';
const VERSION = '1.1.0';

// ---------- GitHub Actions plumbing ----------
const input = (name, def = '') => {
    const v = process.env['INPUT_' + name.toUpperCase()];
    return v === undefined || v === '' ? def : v.trim();
};
const bool = (name, def) => !/^(false|0|no|off)$/i.test(input(name, String(def)));
const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const warn = msg => console.log(`::warning title=YourImageShare::${esc(msg)}`);
const notice = msg => console.log(`::notice title=YourImageShare::${esc(msg)}`);
function setOutput(name, value) {
    if (!process.env.GITHUB_OUTPUT) return;
    const d = 'EOF_' + Math.random().toString(36).slice(2);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${d}\n${value}\n${d}\n`);
}

// ---------- finding failures ----------
const stripAnsi = s => String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const isImage = p => /\.(png|jpe?g|webp)$/i.test(p || '');

/** Failures from a Playwright JSON report: [{title, error, files: [{name, path}]}] */
function fromJsonReport(file, root) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = [];
    const walk = (suite, trail) => {
        const t = suite.title && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(suite.title) ? [...trail, suite.title] : trail;
        for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
                if (test.status !== 'unexpected') continue;          // flaky tests passed on a retry
                const r = (test.results || [])[test.results.length - 1] || {};
                const err = (r.errors && r.errors[0] && r.errors[0].message) || (r.error && r.error.message) || '';
                const files = (r.attachments || []).filter(a => a.path && isImage(a.path) && fs.existsSync(a.path))
                    .map(a => ({ name: a.name, path: a.path }));
                const fileName = spec.file || suite.file || '';
                const title = [fileName, ...t, spec.title].filter(Boolean).join(' › ') + (test.projectName ? ` (${test.projectName})` : '');
                out.push({ title, error: stripAnsi(err), files });
            }
        }
        for (const s of suite.suites || []) walk(s, t);
    };
    for (const s of report.suites || []) walk(s, []);
    return out;
}

/** Failures from the output folder: one folder per failed test, the last retry only. */
function fromResultsDir(dir) {
    if (!fs.existsSync(dir)) return [];
    const byTest = new Map();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const m = ent.name.match(/^(.*?)(?:-retry(\d+))?$/);
        const base = m[1], retry = Number(m[2] || 0);
        const full = path.join(dir, ent.name);
        const files = [];
        const scan = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) scan(p); else if (isImage(f.name)) files.push({ name: f.name.replace(/\.[^.]+$/, ''), path: p });
        } };
        scan(full);
        if (!files.length) continue;
        const prev = byTest.get(base);
        if (!prev || prev.retry < retry) byTest.set(base, { retry, files });
    }
    return [...byTest].map(([base, v]) => ({ title: base, error: '', files: v.files }));
}

/** A Playwright JSON report has "suites" at the top (a mochawesome report from Cypress has "results"). */
function isPlaywrightReport(file) {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.suites); } catch { return false; }
}

/** Every image under a folder (absolute paths). */
function walkImages(dir) {
    const out = [];
    if (!dir || !fs.existsSync(dir)) return out;
    const scan = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) scan(p); else if (isImage(f.name)) out.push(p);
    } };
    scan(dir);
    return out;
}

const noExt = p => path.basename(p).replace(/\.[^.]+$/, '');
const looksLikeCypress = () => ['cypress.config.js', 'cypress.config.ts', 'cypress.config.mjs', 'cypress.config.cjs', 'cypress.json']
    .some(f => fs.existsSync(f)) || fs.existsSync(input('cypress-screenshots', 'cypress/screenshots'));

/** Error messages from a mochawesome report (Cypress), keyed like the screenshot names: "describe -- test". */
function cypressErrors() {
    // one file per spec when reporterOptions.overwrite is false (mochawesome.json, mochawesome_001.json, ...)
    const given = input('json-report');
    const files = given ? [given] : ['mochawesome-report', 'cypress/results', 'cypress/reports', 'cypress/reports/html/.jsons']
        .filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory())
        .flatMap(d => fs.readdirSync(d).filter(f => /^mochawesome.*\.json$/i.test(f)).map(f => path.join(d, f)));
    const errors = new Map();
    const walk = (suite, trail) => {
        const t = suite.title ? [...trail, suite.title] : trail;
        for (const test of suite.tests || []) {
            if (test.fail || test.state === 'failed') errors.set([...t, test.title].join(' -- '), stripAnsi((test.err && (test.err.message || test.err.estack)) || ''));
        }
        for (const s of suite.suites || []) walk(s, t);
    };
    for (const file of files.filter(f => fs.existsSync(f))) {
        try { for (const r of JSON.parse(fs.readFileSync(file, 'utf8')).results || []) walk(r, []); }
        catch (e) { warn(`Could not read the mochawesome report ${file}: ${e.message}`); }
    }
    if (files.length) console.log(`Read ${files.length} mochawesome report(s): ${errors.size} failed test(s) with messages`);
    return errors;
}

/**
 * Cypress failures: the screenshots Cypress takes when a test fails ("<describe> -- <test> (failed).png", last attempt only),
 * plus failed visual comparisons of cypress-image-diff-js (baseline / comparison / diff folders) and
 * cypress-visual-regression (snapshots/base and snapshots/diff; the actual image is a normal Cypress screenshot).
 */
function fromCypress() {
    const shotsDir = input('cypress-screenshots', 'cypress/screenshots');
    const errors = cypressErrors();
    const tests = new Map();
    for (const p of walkImages(shotsDir)) {
        const m = noExt(p).match(/^(.*) \(failed\)(?: \(attempt (\d+)\))?$/);
        if (!m) continue;
        const spec = path.relative(shotsDir, path.dirname(p)).split(path.sep).join('/');
        const k = spec + '|' + m[1], attempt = Number(m[2] || 1);
        const prev = tests.get(k);
        if (prev && prev.attempt >= attempt) continue;
        tests.set(k, { attempt, title: [spec, ...m[1].split(' -- ')].filter(Boolean).join(' › '), error: errors.get(m[1]) || '',
            files: [{ name: 'screenshot', path: p }] });
    }
    const out = [...tests.values()].map(({ attempt, ...t }) => t);
    console.log(`Scanned ${shotsDir}: ${out.length} failed test(s) with screenshots`);

    // cypress-image-diff-js: a diff image is only written when the comparison fails
    const idj = input('image-diff-dir', 'cypress-image-diff-screenshots');
    for (const d of walkImages(path.join(idj, 'diff'))) {
        const rel = path.relative(path.join(idj, 'diff'), d), name = noExt(rel);
        const files = [{ name: name + '-expected', path: path.join(idj, 'baseline', rel) }, { name: name + '-actual', path: path.join(idj, 'comparison', rel) },
            { name: name + '-diff', path: d }].filter(f => fs.existsSync(f.path));
        out.push({ title: 'Visual difference › ' + rel.split(path.sep).join('/').replace(/\.[^.]+$/, ''), error: '', files });
    }

    // cypress-visual-regression: diff/<spec>/<name>[ (attempt N)].png next to base/<spec>/<name>.png
    const vr = input('snapshots-dir', 'cypress/snapshots');
    const shots = walkImages(shotsDir);
    const lastAttempt = new Map();   // with retries there is one diff per attempt: keep the last
    for (const d of walkImages(path.join(vr, 'diff'))) {
        const rel = path.relative(path.join(vr, 'diff'), d), m = noExt(rel).match(/^(.*?)(?: \(attempt (\d+)\))?$/);
        const k = path.dirname(rel) + '|' + m[1], n = Number(m[2] || 1);
        if (!lastAttempt.has(k) || lastAttempt.get(k).n < n) lastAttempt.set(k, { n, d });
    }
    for (const { d } of lastAttempt.values()) {
        const rel = path.relative(path.join(vr, 'diff'), d), dir = path.dirname(rel), full = noExt(rel);
        const name = full.replace(/ \(attempt \d+\)$/, '');
        const specName = path.basename(dir);
        const actual = shots.find(s => path.basename(path.dirname(s)) === specName && noExt(s) === full)
            || shots.find(s => path.basename(path.dirname(s)) === specName && noExt(s) === name);
        const files = [{ name: name + '-expected', path: path.join(vr, 'base', dir, name + '.png') }, actual && { name: name + '-actual', path: actual },
            { name: name + '-diff', path: d }].filter(f => f && fs.existsSync(f.path));
        out.push({ title: `Visual difference › ${specName} › ${name}`, error: '', files });
    }
    return out;
}

/** Split a test's images into visual-diff groups (expected/actual/diff) and plain screenshots. */
function groupFiles(files) {
    const diffs = new Map(), shots = [];
    for (const f of files) {
        // the attachment name says the role (the expected file itself is the baseline, e.g. hero-chromium-linux.png)
        const m = String(f.name || '').match(/^(.*)-(expected|actual|diff)(?:\.[a-z]+)?$/i)
            || path.basename(f.path).match(/^(.*)-(expected|actual|diff)\.[a-z]+$/i);
        if (m) {
            if (!diffs.has(m[1])) diffs.set(m[1], {});
            diffs.get(m[1])[m[2].toLowerCase()] = f;
        } else {
            shots.push(f);
        }
    }
    return { diffs: [...diffs].map(([name, g]) => ({ name, ...g })), shots };
}

// ---------- YourImageShare API ----------
const API = input('api-url', 'https://yourimageshare.com/api').replace(/\/+$/, '');
const KEY = input('api-key');
const UA = `yourimageshare-playwright-action/${VERSION}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathname, body) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(API + pathname, { method: 'POST', body, headers: { 'X-API-Key': KEY, 'User-Agent': UA, Accept: 'application/json' } });
        if (res.status === 429 && attempt < 3) {   // 20 uploads a minute per key: wait as told, then try again
            const wait = Math.min(65, Number(res.headers.get('retry-after')) || 20);
            console.log(`Rate limited, waiting ${wait}s`);
            await sleep(wait * 1000);
            continue;
        }
        if (res.status >= 500 && attempt < 2) { await sleep(3000); continue; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${res.status} ${typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors || data)}`);
        return data;
    }
}

const expiresDays = Number(input('expires-in-days', '30')) || 0;
const visibility = ['private', 'unlisted', 'public'].includes(input('visibility')) ? input('visibility') : 'private';

let TOOL = 'Playwright';   // set in main(): Playwright or Cypress
async function upload(file, title) {
    const fd = new FormData();
    const buf = fs.readFileSync(file.path);
    const ext = path.extname(file.path).slice(1).toLowerCase().replace('jpg', 'jpeg');
    fd.append('uploads', new Blob([buf], { type: 'image/' + ext }), path.basename(file.path));
    fd.append('visibility', visibility);
    fd.append('client', 'github-action-' + TOOL.toLowerCase());   // per-tool upload stats on YourImageShare
    fd.append('title', title.replace(/\s+/g, ' ').slice(0, 90));
    if (expiresDays > 0) fd.append('expires_in', String(Math.min(365, expiresDays) * 86400));
    const d = await api('', fd);
    const item = d.data || d;   // POST /api answers {type, data: {...}} (or the item itself for older shapes)
    return { id: item.id, url: item.src || item.path };
}

async function compare(beforeId, afterId, title) {
    const fd = new FormData();
    fd.append('before', beforeId); fd.append('after', afterId);
    fd.append('title', title.slice(0, 120));
    fd.append('label_before', 'Expected'); fd.append('label_after', 'Actual');
    return api('/compare', fd);
}

// ---------- GitHub API ----------
const GH = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = input('github-token');
async function gh(method, url, body) {
    const res = await fetch(url.startsWith('http') ? url : GH + url, {
        method, body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${method} ${url}: ${res.status} ${data.message || ''}`);
    return data;
}

async function prNumber() {
    let ev = {};
    try { ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch {}
    if (ev.pull_request && ev.pull_request.number) return ev.pull_request.number;
    if (ev.issue && ev.issue.pull_request) return ev.issue.number;
    // a push or a manual run: the open pull request that has this commit, if any
    const sha = process.env.GITHUB_SHA;
    if (!sha || !TOKEN || !REPO) return null;
    try {
        const prs = await gh('GET', `/repos/${REPO}/commits/${sha}/pulls`);
        const open = prs.find(p => p.state === 'open');
        return open ? open.number : null;
    } catch { return null; }
}

async function findComment(pr, marker) {
    for (let page = 1; page <= 10; page++) {
        const list = await gh('GET', `/repos/${REPO}/issues/${pr}/comments?per_page=100&page=${page}`);
        const hit = list.find(c => (c.body || '').includes(marker));
        if (hit) return hit;
        if (list.length < 100) return null;
    }
    return null;
}

// ---------- comment ----------
const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
const fence = s => '```\n' + s.replace(/```/g, '`​``') + '\n```';
const firstLines = (s, n = 6, max = 600) => { const t = s.split('\n').filter(l => l.trim()).slice(0, n).join('\n'); return t.length > max ? t.slice(0, max) + '…' : t; };
const img = (url, alt, w) => `<a href="${url}"><img src="${url}" alt="${alt.replace(/"/g, '&quot;')}" width="${w}"></a>`;

function render({ heading, failures, shown, marker, uploadErrors }) {
    const lines = [`<!-- ${marker} -->`];
    if (!failures.length) {
        lines.push(`### ✅ ${heading}: all tests passed`, '', `Latest run: [${process.env.GITHUB_WORKFLOW || 'workflow'} #${process.env.GITHUB_RUN_NUMBER || ''}](${runUrl})`);
        return lines.join('\n');
    }
    lines.push(`### ❌ ${heading}: ${failures.length} failed test${failures.length === 1 ? '' : 's'}`, '');
    for (const f of shown) {
        lines.push(`<details open><summary><b>${f.title.replace(/</g, '&lt;')}</b></summary>`, '');
        if (f.error) lines.push(fence(firstLines(f.error)), '');
        for (const d of f.diffs) {
            const cells = ['expected', 'actual', 'diff'].filter(k => d[k] && d[k].url);
            if (cells.length) {
                lines.push(`| ${cells.map(k => k[0].toUpperCase() + k.slice(1)).join(' | ')} |`, `| ${cells.map(() => '---').join(' | ')} |`,
                    `| ${cells.map(k => img(d[k].url, `${d.name} ${k}`, 260)).join(' | ')} |`, '');
            }
            if (d.slider) lines.push(`🔀 [Compare expected and actual with a slider](${d.slider})`, '');
        }
        const shots = f.shots.filter(s => s.url).map(s => img(s.url, s.name, 600));
        if (shots.length && f.diffs.length) lines.push('<details><summary>Full page</summary>', '', ...shots, '', '</details>', '');   // the table says it all
        else for (const s of shots) lines.push(s, '');
        if (!f.diffs.length && !f.shots.some(s => s.url)) lines.push('_No screenshot was saved for this test._', '');
        lines.push('</details>', '');
    }
    if (failures.length > shown.length) lines.push(`…and ${failures.length - shown.length} more failed test(s). See the [workflow run](${runUrl}).`, '');
    if (uploadErrors) lines.push(`⚠️ ${uploadErrors} screenshot(s) could not be uploaded. See the run log.`, '');
    const keep = expiresDays > 0 ? `deleted after ${expiresDays} day${expiresDays === 1 ? '' : 's'}` : 'kept until you delete them';
    lines.push('---', `<sub>[Workflow run](${runUrl}) · Screenshots hosted on [YourImageShare](https://yourimageshare.com/?ref=gh-action), ${keep}. Updated on every run.</sub>`);
    return lines.join('\n');
}

// ---------- main ----------
function collectPlaywright() {
    let failures = [];
    const candidates = [input('json-report'), 'playwright-report/results.json', 'test-results.json', 'results.json'].filter(Boolean);
    const report = candidates.find(p => fs.existsSync(p) && isPlaywrightReport(p));
    if (report) {
        try { failures = fromJsonReport(report); console.log(`Read ${report}: ${failures.length} failed test(s)`); }
        catch (e) { warn(`Could not read the JSON report ${report}: ${e.message}`); }
    }
    if (!report || (!failures.length && input('json-report') === '')) {
        const dir = input('results-dir', 'test-results');
        const dirFailures = fromResultsDir(dir);
        if (!report || dirFailures.length) { failures = dirFailures; console.log(`Scanned ${dir}: ${failures.length} test folder(s) with screenshots`); }
    }
    return failures;
}

async function main() {
    const key = input('comment-key') || process.env.GITHUB_JOB || 'default';
    const marker = `${MARK}:${key}`;

    // which test tool: "auto" looks for Playwright results first, then Cypress
    const fw = input('framework', 'auto').toLowerCase();
    let failures = [], framework = 'Playwright';
    if (fw === 'cypress') {
        failures = fromCypress(); framework = 'Cypress';
    } else if (fw === 'playwright') {
        failures = collectPlaywright();
    } else {
        failures = collectPlaywright();
        if (!failures.length) {
            const cy = fromCypress();
            if (cy.length || looksLikeCypress()) { failures = cy; framework = 'Cypress'; }
        }
    }
    TOOL = framework;
    const heading = input('title') || framework;
    setOutput('failed', failures.length);

    const doComment = bool('comment', true);
    const pr = doComment && TOKEN ? await prNumber() : null;
    let existing = null;
    if (pr) { try { existing = await findComment(pr, marker); } catch (e) { warn(e.message); } }

    if (!failures.length && !existing) { console.log('No failures and no earlier comment: nothing to do.'); return; }
    if (failures.length && !KEY) {
        warn('No api-key: screenshots were not uploaded. Pull requests from forks get no secrets; for your own branches add the YOURIMAGESHARE_API_KEY secret.');
        return;
    }

    const max = Math.max(1, Number(input('max-tests', '20')) || 20);
    const shown = failures.slice(0, max).map(f => ({ ...f, ...groupFiles(f.files) }));
    const uploaded = [];
    let uploadErrors = 0;
    for (const f of shown) {
        const items = [...f.diffs.flatMap(d => ['expected', 'actual', 'diff'].filter(k => d[k]).map(k => d[k])), ...f.shots];
        for (const file of items) {
            try {
                const r = await upload(file, `${f.title} - ${file.name}`);
                Object.assign(file, r);
                uploaded.push({ test: f.title, name: file.name, url: r.url });
            } catch (e) { uploadErrors++; warn(`Upload failed for ${file.path}: ${e.message}`); }
        }
        if (bool('slider', true)) {
            for (const d of f.diffs) {
                if (!d.expected?.id || !d.actual?.id) continue;
                try { d.slider = (await compare(d.expected.id, d.actual.id, `${f.title} - ${d.name}`)).url; }
                catch (e) { warn(`Could not make the slider for ${d.name}: ${e.message}`); }
            }
        }
    }
    setOutput('screenshots', JSON.stringify(uploaded));
    console.log(`Uploaded ${uploaded.length} screenshot(s)`);

    const body = render({ heading, failures, shown, marker, uploadErrors });
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');

    if (!doComment) return;
    if (!pr) { notice('No pull request for this run: results are in the job summary.'); return; }
    try {
        const c = existing
            ? await gh('PATCH', `/repos/${REPO}/issues/comments/${existing.id}`, { body })
            : await gh('POST', `/repos/${REPO}/issues/${pr}/comments`, { body });
        setOutput('comment-url', c.html_url);
        console.log(`Comment: ${c.html_url}`);
    } catch (e) {
        warn(`Could not write the pull request comment (${e.message}). Give the job "permissions: pull-requests: write". Results are in the job summary.`);
    }
}

main().catch(e => warn(`Unexpected error: ${e.stack || e.message}`));
