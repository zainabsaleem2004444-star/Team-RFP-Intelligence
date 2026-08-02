# Docker Setup Guide — Team-RFP-Intelligence

## Point 24: Dockerized Backend ✅

This guide covers containerizing the entire stack (backend + Redis + frontend) for one-command setup.

---

## Prerequisites

### Install Docker & Docker Compose

**macOS:**
```bash
brew install docker docker-compose
# Or download Docker Desktop: https://www.docker.com/products/docker-desktop
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update && sudo apt install -y docker.io docker-compose
sudo usermod -aG docker $USER  # Add current user to docker group
```

**Windows:**
- Download Docker Desktop: https://www.docker.com/products/docker-desktop
- Enable WSL2 backend in Docker Desktop settings

---

## Quick Start (One Command)

### 1. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add your **Gemini API Key**:
```env
GEMINI_API_KEY=your_actual_api_key_here
```

### 2. Start Everything

```bash
docker-compose up -d
```

That's it! Everything starts automatically:
- ✅ Redis database (localhost:6379)
- ✅ Backend server (http://localhost:3001)
- ✅ Frontend with Nginx (http://localhost:8080)

### 3. Verify Services Are Running

```bash
docker-compose ps
```

Should show:
```
CONTAINER ID   IMAGE                    STATUS      PORTS
xxx            rfp-redis               Up (healthy) 6379->6379
xxx            rfp-backend             Up (healthy) 3001->3001
xxx            rfp-frontend            Up           8080->80
```

### 4. View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f redis
docker-compose logs -f frontend
```

### 5. Stop Everything

```bash
docker-compose down
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│         User Browser                    │
│      (http://localhost:8080)            │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────▼──────────┐
        │   Nginx (Frontend)  │
        │   Port: 8080        │
        └──────────┬──────────┘
                   │ /api/* → proxy
        ┌──────────▼──────────────┐
        │   Node.js Backend       │
        │   Port: 3001            │
        │  • Express server       │
        │  • Gemini API calls     │
        │  • PDF processing       │
        │  • BullMQ job queue     │
        └──────────┬──────────────┘
                   │
        ┌──────────┴──────────────────────────┐
        │                                     │
    ┌───▼────┐                          ┌────▼─────┐
    │ SQLite │                          │  Redis   │
    │ DB     │                          │ Queue    │
    │ (file) │                          │ Broker   │
    └────────┘                          └──────────┘
```

---

## Docker Files Explained

### `Dockerfile`
- Based on Node 22.5.0 Alpine (small, fast)
- Installs Chromium (needed for Puppeteer)
- Copies only production dependencies
- Sets up health checks
- Exposes port 3001

### `docker-compose.yml`
- **Redis**: In-memory store for job queues
- **Backend**: Your Node.js application
- **Frontend**: Nginx serving static files + API proxy
- **Volumes**: Persistent data for SQLite & Redis
- **Networks**: Services communicate via Docker network

### `nginx.conf`
- Serves frontend from `/usr/share/nginx/html`
- Proxies `/api/*` requests to backend on port 3001
- Handles CORS headers
- Compresses responses with gzip
- Max upload size: 100MB

### `.dockerignore`
- Excludes `node_modules`, `.git`, logs from Docker image
- Keeps image size small (~1.5GB instead of 5GB+)

---

## Common Tasks

### Rebuild Docker Image

After updating `package.json`:

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Access Backend Shell

```bash
docker-compose exec backend sh
```

Inside container:
```bash
ls -la
npm run lint
npm run test
node -v
```

### Access Redis CLI

```bash
docker-compose exec redis redis-cli
```

Commands:
```
KEYS *                 # List all keys
GET mykey              # Get value
FLUSHALL               # Clear everything
MONITOR                # Watch all commands
```

### View Database

SQLite database is stored in `./backend/data/rfp.db`. View with:

```bash
docker-compose exec backend sqlite3 /app/data/rfp.db
```

```sql
SELECT * FROM analyses;
.schema                # Show table structure
.exit                  # Exit
```

### Update Backend Code

Changes to `backend/` are automatically hot-reloaded (volume mount):

```bash
# Edit backend/server.js
# Service restarts automatically (if using nodemon)
```

### Change a Service Port

Edit `docker-compose.yml`:

```yaml
backend:
  ports:
    - "3002:3001"  # Map to 3002 instead of 3001
```

Then restart:
```bash
docker-compose up -d
```

---

## Environment Variables

### In `.env` file:

```env
# Required
GEMINI_API_KEY=your_key

# Optional (defaults shown)
PORT=3001
NODE_ENV=development
DATABASE_PATH=/app/data/rfp.db
REDIS_URL=redis://redis:6379
MAX_FILE_SIZE=52428800
RATE_LIMIT=100
LOG_LEVEL=debug
```

### Docker-specific:

```yaml
# In docker-compose.yml, these override .env
environment:
  - REDIS_URL=redis://redis:6379  # Not localhost!
  - DATABASE_PATH=/app/data/rfp.db
```

**Important:** Inside Docker, use service names (`redis`, `backend`) instead of localhost.

---

## Performance Optimization

### Reduce Image Size

Current: ~1.5GB. To reduce:

```dockerfile
# Use alpine base (already done)
FROM node:22.5.0-alpine

# Remove optional dependencies
RUN npm ci --only=production
```

### Speed Up Builds

```bash
# Use Docker BuildKit (faster)
DOCKER_BUILDKIT=1 docker-compose build
```

### Limit Resource Usage

Edit `docker-compose.yml`:

```yaml
backend:
  deploy:
    resources:
      limits:
        cpus: '1'        # 1 CPU max
        memory: 1024M    # 1GB RAM max
```

---

## Troubleshooting

### ❌ "docker: command not found"

Docker is not installed. See Prerequisites above.

### ❌ "Cannot connect to Docker daemon"

```bash
# Start Docker daemon
sudo systemctl start docker

# Or on macOS, open Docker Desktop app
```

### ❌ "Port 3001 is already in use"

```bash
# Find what's using port 3001
lsof -i :3001

# Kill the process
kill -9 <PID>

# Or change port in docker-compose.yml
ports:
  - "3002:3001"
```

### ❌ "Cannot find module 'express'"

Dependencies not installed in Docker:

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### ❌ "Gemini API returns 403"

Check your API key in `.env`:

```bash
cat .env | grep GEMINI_API_KEY
docker-compose logs backend | grep -i api
```

### ❌ "Redis connection refused"

Redis service didn't start:

```bash
docker-compose logs redis
docker-compose restart redis
```

### ❌ "Frontend shows 502 Bad Gateway"

Backend not responding. Check logs:

```bash
docker-compose logs backend
docker-compose restart backend
```

---

## Production Deployment

Docker makes deployment simple. For production:

### 1. Push Image to Registry

```bash
# Build for production
docker build -f Dockerfile -t myrepo/rfp-backend:1.0.0 backend/

# Push to Docker Hub, AWS ECR, Google Artifact Registry, etc.
docker push myrepo/rfp-backend:1.0.0
```

### 2. Deploy to Cloud

**Railway/Render (simplest):**
- Connect GitHub repo
- Set `GEMINI_API_KEY` as environment variable
- Deploy automatically

**AWS ECS:**
```bash
aws ecs create-service --cluster rfp-prod \
  --service-name backend \
  --task-definition rfp-backend:1
```

**Google Cloud Run:**
```bash
gcloud run deploy rfp-backend \
  --image gcr.io/project/rfp-backend:latest \
  --set-env-vars GEMINI_API_KEY=$KEY
```

See **Point 25** (Auto-deploy) for GitHub Actions automation.

---

## Health Checks

Docker monitors service health:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "..."]  # How to test
  interval: 30s                        # Test every 30s
  timeout: 10s                         # Wait max 10s
  retries: 3                           # Fail after 3 misses
```

If unhealthy, Docker restarts the service automatically.

---

## Useful Docker Commands

```bash
# List all images
docker images

# List running containers
docker ps

# View container logs
docker logs <container_id>

# Execute command in running container
docker exec <container_id> npm run lint

# Remove unused images/volumes
docker system prune -a

# View resource usage
docker stats

# Inspect container details
docker inspect <container_id>
```

---

## Next Steps (Point 25)

Once Docker is working, automate deployments:

- Set up GitHub Actions to build & push Docker image
- Deploy to Render/Railway on every push to `main`
- Configure environment variables in cloud platform
- See `CI-SETUP-GUIDE.md` for Point 25 auto-deploy

---

## Files in This Setup

```
Team-RFP-Intelligence/
├── Dockerfile                    ← Docker image definition
├── docker-compose.yml            ← Full stack orchestration
├── nginx.conf                    ← Frontend + proxy config
├── .dockerignore                 ← Exclude files from image
├── .env.example                  ← Environment template
├── backend/
│   ├── package.json
│   ├── server.js
│   ├── db.js
│   └── queue.js
└── frontend/
    └── index.html
```

---

**Questions?** See Docker docs: https://docs.docker.com/compose/
