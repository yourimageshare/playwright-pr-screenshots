# Playwright failure screenshots in PR comments

See **why** a Playwright test failed without leaving the pull request. When tests fail, this action uploads the failure
screenshots and visual diffs to [YourImageShare](https://yourimageshare.com) (free) and posts them as images in one pull
request comment. No more downloading artifact zips to find the right PNG.

- Failure screenshots shown inline, with the error message
- Visual comparison failures (`toHaveScreenshot`) as an **Expected | Actual | Diff** table, plus a link to a
  **before/after slider** of expected vs actual
- One comment per job, updated on every run; it switches to "✅ all tests passed" once the tests are fixed
- The same report in the job summary, also for pushes without a pull request
- Screenshots are private (image files only, no public pages) and **deleted after 30 days** by default
- Never fails your build: problems are reported as warnings

## Setup (2 minutes)

1. Create a free account at [yourimageshare.com](https://yourimageshare.com), open **My account → API** and copy the
   **upload-only key**.
2. In your repository: **Settings → Secrets and variables → Actions → New repository secret**, name it
   `YOURIMAGESHARE_API_KEY`.
3. Make Playwright keep screenshots of failures (in `playwright.config.ts`):

   ```ts
   use: { screenshot: 'only-on-failure' },
   ```

4. Add the action after your test step:

```yaml
name: e2e
on: pull_request

permissions:
  contents: read
  pull-requests: write   # to write the comment

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test

      - uses: yourimageshare/playwright-pr-screenshots@v1
        if: always()   # run after failed tests too
        with:
          api-key: ${{ secrets.YOURIMAGESHARE_API_KEY }}
```

`if: always()` matters: without it the step is skipped when the tests fail.

## Better test names and error messages (optional)

Without a report the action reads Playwright's `test-results` folder, where each failed test has its own folder. For the
exact test titles and the error message in the comment, also write a JSON report:

```ts
// playwright.config.ts
reporter: [['list'], ['json', { outputFile: 'test-results.json' }]],
```

The action finds `test-results.json`, `results.json` or `playwright-report/results.json` by itself; otherwise set
`json-report`.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `api-key` | (required) | Your YourImageShare API key (the upload-only key is enough). |
| `results-dir` | `test-results` | Playwright's `outputDir`. |
| `json-report` | | Path to a Playwright JSON report. |
| `max-tests` | `20` | Most failed tests shown with screenshots; the rest are counted. |
| `expires-in-days` | `30` | Delete the screenshots after this many days. `0` keeps them. |
| `visibility` | `private` | `private` (image files only), `unlisted` or `public`. |
| `slider` | `true` | Make a before/after slider for visual comparison failures. |
| `comment` | `true` | Write the pull request comment. `false` = job summary only. |
| `comment-key` | job id | One comment per key. Set it per matrix entry, e.g. `${{ matrix.browser }}`. |
| `title` | `Playwright` | Heading of the comment. |
| `github-token` | `github.token` | Token for the comment. |

## Outputs

| Output | |
| --- | --- |
| `failed` | Number of failed tests found. |
| `comment-url` | Link to the comment. |
| `screenshots` | JSON list of `{test, name, url}`. |

## Matrix jobs

```yaml
    strategy:
      matrix:
        browser: [chromium, firefox, webkit]
    steps:
      # ...
      - run: npx playwright test --project=${{ matrix.browser }}
      - uses: yourimageshare/playwright-pr-screenshots@v1
        if: always()
        with:
          api-key: ${{ secrets.YOURIMAGESHARE_API_KEY }}
          comment-key: ${{ matrix.browser }}
          title: Playwright (${{ matrix.browser }})
```

## Pull requests from forks

GitHub gives no secrets to workflows started by pull requests from forks, so there is no API key: the action then skips
the upload and leaves a notice. Pull requests from branches of your own repository work normally.

## Limits and privacy

- An API key can upload 20 screenshots a minute (the action waits and retries when it reaches that) and 2000 a day with
  the upload-only key.
- Screenshots of your app can show things you don't want public. By default they are `private`: only the image files
  exist, with long random names, no page, never listed or searchable, and they are deleted after 30 days.
- Uploads go through YourImageShare's normal content checks.
- You can see and delete everything the action uploaded in **My account**.

## License

MIT
