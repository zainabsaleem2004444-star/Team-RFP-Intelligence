# Team-RFP-Intelligence — Phase 6 Implementation Guide
## Points 23-24: CI/CD Pipeline & Docker Containerization

---

## 📋 What's Included (Point 23 & 24)

### Point 23: CI/CD Pipeline (GitHub Actions)
✅ Automated testing on every push  
✅ ESLint linting checks  
✅ Jest test framework  
✅ Node.js syntax validation  
✅ Frontend HTML validation  

**Files:**
- `.github/workflows/ci.yml` — Main workflow
- `.eslintrc.json` — Linting configuration
- `jest.config.js` — Test configuration
- `backend/package.json` — Updated with npm scripts
- `backend/db.test.js` — Sample test file
- `CI-SETUP-GUIDE.md` — Full documentation
- `CI-QUICK-START.md` — 5-minute setup

### Point 24: Dockerized Backend
✅ One-command setup for entire stack  
✅ Redis for job queues  
✅ Nginx reverse proxy + frontend  
✅ Persistent SQLite database  
✅ Health checks included  

**Files:**
- `Dockerfile` — Backend container
- `docker-compose.yml` — Full stack orchestration
- `nginx.conf` — Frontend/proxy configuration
- `.dockerignore` — Optimize image size
- `.env.example` — Environment template
- `DOCKER-SETUP.md` — Full documentation
- `DOCKER-QUICK-START.md` — Quick reference

---

## 🚀 Quick Start Guide (Choose One)

### Option A: Docker (Recommended) — 3 Minutes

```bash
# 1. Set environment
cp .env.example .env
# Edit .env and add: GEMINI_API_KEY=your_key

# 2. Start everything (backend + redis + frontend)
docker-compose up -d

# 3. Open browser
# Frontend: http://localhost:8080
# Backend: http://localhost:3001
```

**Done!** No npm install, no Redis setup needed.

### Option B: Local Development with CI/CD — 10 Minutes

```bash
# 1. Install dependencies
cd backend
npm install --save-dev eslint jest
npm install

# 2. Create .env file
cp ../.env.example ../.env
# Edit and add GEMINI_API_KEY

# 3. Start backend
npm start

# 4. Run CI checks locally
npm run lint      # Linting
npm run test      # Tests
npm run check-syntax  # Syntax check

# 5. Push to GitHub (GitHub Actions runs automatically)
git push
```

---

## 📖 Documentation

### For CI/CD (Point 23)

| Document | Purpose | Time |
|----------|---------|------|
| `CI-QUICK-START.md` | 5-minute setup + copy-paste | 5 min |
| `CI-SETUP-GUIDE.md` | Detailed explanations + troubleshooting | 20 min |

### For Docker (Point 24)

| Document | Purpose | Time |
|----------|---------|------|
| `DOCKER-QUICK-START.md` | Commands reference card | 2 min |
| `DOCKER-SETUP.md` | Complete guide + architecture | 30 min |

---

## 🏗️ Architecture Overview

```
PHASE 23: CI/CD Pipeline
┌────────────────────────────────┐
│   GitHub (Your Repository)     │
│  - Push code to main/develop   │
│  - GitHub detects .github/workflows/ci.yml
└────────────────┬───────────────┘
                 │
      ┌──────────▼──────────┐
      │  GitHub Actions     │
      │  Runs automatically │
      ├─────────────────────┤
      │ ✓ Install deps      │
      │ ✓ ESLint checks     │
      │ ✓ Jest tests        │
      │ ✓ Syntax validation │
      │ ✓ Build check       │
      └─────────────────────┘

PHASE 24: Docker Architecture
┌─────────────────────────────────────────┐
│   Developer Machine (Local)             │
│  docker-compose up -d                   │
└────────────┬────────────────────────────┘
             │
      ┌──────┴───────────────────────┐
      │                              │
  ┌───▼────┐                    ┌───▼────┐
  │ Redis  │                    │ Backend│
  │ 6379   │◄──────────────────►│ 3001   │
  └────────┘                    │ Node   │
      ▲                         │ +      │
      │                         │ Pup    │
      │                         └───┬────┘
      │                             │
      │                         ┌───▼────┐
      │                         │ SQLite │
      │                         │ /data/ │
      └─────────────────────────└────────┘
      
  ┌──────────────────────────┐
  │ Frontend (Nginx)         │
  │ Port: 8080               │
  │ Serves index.html        │
  │ Proxies /api to backend  │
  └──────────────────────────┘
```

---

## 📁 New Project Structure

```
Team-RFP-Intelligence/
│
├── .github/
│   └── workflows/
│       └── ci.yml                    ← Point 23: GitHub Actions
│
├── backend/
│   ├── package.json                  ← Updated with CI scripts
│   ├── db.test.js                    ← Sample test
│   ├── server.js
│   ├── db.js
│   └── queue.js
│
├── frontend/
│   └── index.html
│
├── Dockerfile                        ← Point 24: Backend container
├── docker-compose.yml                ← Point 24: Full stack setup
├── nginx.conf                        ← Point 24: Frontend/proxy
├── .dockerignore                     ← Point 24: Optimize image
├── .env.example                      ← Environment template
│
├── .eslintrc.json                    ← Point 23: Linting config
├── jest.config.js                    ← Point 23: Test config
│
├── CI-SETUP-GUIDE.md                 ← Point 23: Full docs
├── CI-QUICK-START.md                 ← Point 23: Quick ref
├── DOCKER-SETUP.md                   ← Point 24: Full docs
├── DOCKER-QUICK-START.md             ← Point 24: Quick ref
│
└── readme.md                         ← Original project README
```

---

## 🛠️ Typical Workflows

### Workflow 1: Local Development + GitHub Actions

```bash
# 1. Start backend locally
cd backend
npm start

# 2. Edit code
# vim server.js

# 3. Run checks locally
npm run lint:fix
npm run test

# 4. Commit and push
git add .
git commit -m "feat: add new feature"
git push

# 5. GitHub Actions runs automatically
# → Check https://github.com/yourname/repo/actions
```

### Workflow 2: Docker-based Development

```bash
# 1. Start entire stack
docker-compose up -d

# 2. Access backend (if needed)
docker-compose exec backend sh

# 3. View logs in real-time
docker-compose logs -f backend

# 4. Make changes (auto-reload via volume mount)
# Edit backend/server.js

# 5. Test via API
curl http://localhost:3001/api/analyze

# 6. Stop when done
docker-compose down
```

### Workflow 3: Production Deployment

```bash
# 1. Build Docker image
docker build -t myrepo/rfp-backend:1.0.0 backend/

# 2. Push to registry
docker push myrepo/rfp-backend:1.0.0

# 3. Deploy to cloud (Render, Railway, AWS, etc)
# See Point 25: Auto-deploy on push

# 4. Monitor with:
docker logs <container_id>
docker stats
```

---

## ✅ Implementation Checklist

### Point 23: CI/CD Setup

- [ ] Files copied to project:
  - [ ] `.github/workflows/ci.yml`
  - [ ] `.eslintrc.json`
  - [ ] `jest.config.js`
  - [ ] `backend/package.json` (updated)
  - [ ] `backend/db.test.js`

- [ ] Dependencies installed:
  ```bash
  cd backend && npm install --save-dev eslint jest
  ```

- [ ] Tests locally:
  ```bash
  npm run lint      # ✓ Should pass
  npm run test      # ✓ Should pass
  ```

- [ ] Pushed to GitHub:
  ```bash
  git push
  ```

- [ ] GitHub Actions verified:
  - [ ] Go to `Actions` tab
  - [ ] See workflow runs
  - [ ] All checks passing ✓

### Point 24: Docker Setup

- [ ] Files in project:
  - [ ] `Dockerfile`
  - [ ] `docker-compose.yml`
  - [ ] `nginx.conf`
  - [ ] `.dockerignore`
  - [ ] `.env.example`

- [ ] Created `.env` file:
  ```bash
  cp .env.example .env
  # Add GEMINI_API_KEY
  ```

- [ ] Docker & Docker Compose installed

- [ ] Stack running:
  ```bash
  docker-compose up -d
  ```

- [ ] Services verified:
  - [ ] Frontend: http://localhost:8080 ✓
  - [ ] Backend: http://localhost:3001/health ✓
  - [ ] Redis: `docker-compose exec redis redis-cli PING` ✓

---

## 🚨 Troubleshooting

### CI/CD Issues (Point 23)

| Issue | Solution |
|-------|----------|
| ESLint fails | Run `npm run lint:fix` locally |
| Tests timeout | Increase `testTimeout` in jest.config.js |
| GitHub Actions not running | Check `.github/workflows/ci.yml` path |
| npm packages missing | Run `npm ci` after updating package.json |

See `CI-SETUP-GUIDE.md` for detailed troubleshooting.

### Docker Issues (Point 24)

| Issue | Solution |
|-------|----------|
| Port 3001 already in use | Change in docker-compose.yml to port 3002 |
| Cannot connect to Docker daemon | Start Docker service: `sudo systemctl start docker` |
| Gemini API 403 error | Check GEMINI_API_KEY in .env |
| Redis connection refused | `docker-compose restart redis` |
| Frontend shows "502 Bad Gateway" | Check backend logs: `docker-compose logs backend` |

See `DOCKER-SETUP.md` for detailed troubleshooting.

---

## 📚 Next Steps

After Point 23 & 24 are implemented:

### Point 25: Auto-Deploy on Push
- Automatically build & push Docker image to registry
- Deploy to Render/Railway on every push to `main`
- Set up GitHub Secrets for deployment

### Point 26: Environment-Based Config
- Separate `.env.dev` and `.env.production`
- No manual swapping needed

### Point 27: Zero-Training Guarantee
- Add documentation confirming user data never trains public models
- Document data handling practices

---

## 🔗 Useful Links

**Docker:**
- Installation: https://docs.docker.com/install
- Docker Compose: https://docs.docker.com/compose

**GitHub Actions:**
- Documentation: https://docs.github.com/actions
- Workflow syntax: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions

**ESLint:**
- Rules: https://eslint.org/docs/rules

**Jest:**
- Getting started: https://jestjs.io/docs/getting-started
- API: https://jestjs.io/docs/api

---

## 📞 Quick Help

```bash
# See what's running
docker-compose ps

# View logs
docker-compose logs -f

# SSH into backend
docker-compose exec backend sh

# Run npm commands in container
docker-compose exec backend npm run lint

# Stop everything
docker-compose down

# Run CI checks locally
cd backend
npm run lint
npm run test
npm run check-syntax
```

---

## ✨ Summary

You now have:

✅ **Point 23** — GitHub Actions CI/CD pipeline  
- Automatic testing on every push
- ESLint + Jest + syntax validation
- Visible results in GitHub Actions tab

✅ **Point 24** — Dockerized backend  
- One-command setup: `docker-compose up -d`
- Redis, backend, frontend all running
- No manual dependency installation
- Production-ready containerization

**Total setup time:** ~10 minutes  
**Ongoing time:** 0 minutes (fully automated)

🚀 **Ready to move to Point 25: Auto-Deploy!**
