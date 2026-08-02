# CI/CD Quick Start (5 Minutes)

## Copy These Files to Your Repo

```
1. .github/workflows/ci.yml          → .github-workflows-ci.yml
2. .eslintrc.json                    → .eslintrc.json
3. jest.config.js                    → jest.config.js
4. backend/package.json              → backend-package.json
5. backend/db.test.js                → backend-db.test.js
6. .gitignore (append)               → .gitignore-template
```

## Terminal Commands

```bash
# 1. Go to your project
cd Team-RFP-Intelligence

# 2. Create workflows directory
mkdir -p .github/workflows

# 3. Copy workflow file (paste content from .github-workflows-ci.yml)
# 4. Copy config files (paste content from other files)

# 5. Update dependencies
cd backend
npm install --save-dev eslint jest
npm install

# 6. Test locally
npm run lint      # Check code quality
npm run test      # Run tests
npm run lint:fix  # Auto-fix linting issues

# 7. Commit and push
git add .
git commit -m "feat: add CI/CD pipeline"
git push

# 8. Watch in GitHub
# Go to Actions tab → See your workflow run!
```

## What Happens on Push

✅ **Node 22.5.0 is installed**  
✅ **Dependencies are installed** (`npm ci`)  
✅ **Code is linted** (ESLint checks)  
✅ **Syntax is validated** (Node.js --check)  
✅ **Tests are run** (Jest)  
✅ **Results are shown** in GitHub UI  

## If Tests Fail

1. Click the failed workflow in GitHub Actions
2. Scroll to see which step failed
3. Read the error message
4. Run `npm run lint:fix` locally
5. Or update `.eslintrc.json` to be less strict
6. Push again

## Disable a Check (Temporary)

In `.github/workflows/ci.yml`, find the step and add:
```yaml
continue-on-error: true
```

This allows the workflow to pass even if that step fails.

---

**Done!** Your CI/CD pipeline is now active. Every push will run checks automatically. 🚀
