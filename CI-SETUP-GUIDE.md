# GitHub Actions CI/CD Setup for Team-RFP-Intelligence

## What's Included

This CI pipeline automatically runs on **every push** and **pull request** and performs:
- ✅ Node.js 22.5.0 setup & dependency installation
- ✅ ESLint linting (code quality checks)
- ✅ Syntax validation (Node.js built-in --check)
- ✅ Jest tests (basic testing framework)
- ✅ Frontend HTML validation

---

## Implementation Steps

### Step 1: Copy Files to Your GitHub Repo

```bash
# In your local Team-RFP-Intelligence repo directory

# Create GitHub workflows folder
mkdir -p .github/workflows

# Copy the CI workflow
cp .github-workflows-ci.yml .github/workflows/ci.yml

# Copy configuration files to project root
cp .eslintrc.json .eslintrc.json
cp jest.config.js jest.config.js

# Update backend package.json
cp backend-package.json backend/package.json

# Copy sample test file
cp backend-db.test.js backend/db.test.js
```

### Step 2: Update Backend Dependencies

In your `backend/` directory:

```bash
cd backend
npm install --save-dev eslint jest
npm install
```

### Step 3: Push to GitHub

```bash
git add .github/ .eslintrc.json jest.config.js backend/package.json backend/db.test.js
git commit -m "feat: add GitHub Actions CI/CD pipeline"
git push
```

Once pushed, GitHub will automatically:
1. Detect the `.github/workflows/ci.yml` file
2. Run the workflow on every push to `main` or `develop`
3. Show results in the **Actions** tab of your repo

---

## What Runs on Every Push

### Backend Checks

| Check | Script | Purpose |
|-------|--------|---------|
| **Linting** | `npm run lint` | Catches code style issues |
| **Syntax Check** | `npm run check-syntax` | Validates Node.js syntax |
| **Tests** | `npm run test` | Runs Jest test suite |

### Frontend Checks

| Check | Purpose |
|-------|---------|
| **HTML Validation** | Checks frontend/index.html exists |

---

## How to Add More Tests

### Example: Server.js Test

Create `backend/server.test.js`:

```javascript
describe('Server Module', () => {
  test('server module exports app', () => {
    // Mock express to avoid starting the server
    jest.mock('express');
    const app = require('../server.js');
    expect(app).toBeDefined();
  });
});
```

### Example: Database Queries

Create `backend/db.test.js` with actual tests:

```javascript
describe('Database - Get Analysis', () => {
  test('should return analysis by ID', async () => {
    const analysis = await db.getAnalysis(1);
    expect(analysis).toHaveProperty('id');
  });
});
```

---

## How to Use the CI Pipeline

### Check Status in GitHub

1. Go to your repo → **Actions** tab
2. See all past and current workflow runs
3. Click on a run to see detailed logs
4. Red ✗ = failed checks, Green ✓ = passed

### Local Testing Before Push

Run checks locally before pushing:

```bash
# Lint your code
cd backend && npm run lint

# Fix linting issues automatically
npm run lint:fix

# Run tests
npm run test

# Check syntax only
npm run check-syntax
```

### Disable Checks Temporarily

In `.github/workflows/ci.yml`, set `continue-on-error: true` on a step to allow it to fail without blocking.

---

## Troubleshooting

### ❌ "npm ci: not found"

If you see this in GitHub Actions, ensure:
- `package-lock.json` exists in backend/
- You committed it to git

### ❌ ESLint errors block the build

Fix them with:
```bash
cd backend && npm run lint:fix
```

Or relax rules in `.eslintrc.json` by changing violations to `"warn"` instead of `"error"`.

### ❌ Tests timing out

Increase timeout in `jest.config.js`:
```javascript
testTimeout: 30000  // 30 seconds
```

---

## Next Steps (Phase 6)

This CI pipeline fulfills **Point 23**. Next:

- **Point 24**: Add `Dockerfile` for backend (Docker image)
- **Point 25**: Add GitHub Actions auto-deploy step to Render/Railway
- **Point 26**: Add environment-based config (dev/prod `.env.example`)
- **Point 27**: Add zero-training guarantee documentation

---

## File Structure After Setup

```
Team-RFP-Intelligence/
├── .github/
│   └── workflows/
│       └── ci.yml                 ← Main CI workflow
├── .eslintrc.json                 ← Linting rules
├── jest.config.js                 ← Test configuration
├── backend/
│   ├── package.json               ← Updated with new scripts
│   ├── package-lock.json
│   ├── server.js
│   ├── db.js
│   ├── queue.js
│   └── db.test.js                 ← Sample test
└── frontend/
    └── index.html
```

---

## ESLint Rules Reference

Your `.eslintrc.json` enforces:
- Single quotes for strings
- 2-space indentation
- Semicolons required
- No trailing spaces
- Strict equality (`===`)
- Proper brace style

To relax a rule, change `"error"` → `"warn"` or remove it entirely.

---

## Questions?

- **GitHub Actions Docs**: https://docs.github.com/en/actions
- **ESLint Docs**: https://eslint.org/docs/latest/
- **Jest Docs**: https://jestjs.io/docs/getting-started
