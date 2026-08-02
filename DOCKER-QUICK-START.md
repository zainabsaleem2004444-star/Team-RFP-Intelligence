# Docker Quick Reference

## Setup (First Time Only)

```bash
# 1. Create .env file
cp .env.example .env

# 2. Edit .env and add Gemini API key
nano .env

# 3. Start all services
docker-compose up -d
```

## Access Services

```
Frontend:  http://localhost:8080
Backend:   http://localhost:3001
Redis:     localhost:6379
```

## Useful Commands

```bash
# View all services status
docker-compose ps

# View logs
docker-compose logs -f          # All services
docker-compose logs -f backend  # Just backend

# Stop services
docker-compose down

# Restart specific service
docker-compose restart backend

# Enter container shell
docker-compose exec backend sh

# Run npm commands in container
docker-compose exec backend npm run lint
docker-compose exec backend npm run test

# View database
docker-compose exec backend sqlite3 /app/data/rfp.db

# Access Redis CLI
docker-compose exec redis redis-cli
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 3001 already in use | Change in docker-compose.yml: `ports: ["3002:3001"]` |
| "Cannot connect to Docker daemon" | Start Docker: `sudo systemctl start docker` |
| Backend logs show 403 error | Check GEMINI_API_KEY in .env |
| Redis connection refused | `docker-compose restart redis` |
| Dependencies not found | `docker-compose build --no-cache && docker-compose up -d` |

## File Structure

```
.
├── Dockerfile              ← Backend container definition
├── docker-compose.yml      ← Full stack (backend + redis + frontend)
├── nginx.conf              ← Frontend server config
├── .env.example            ← Environment template (copy to .env)
├── backend/
│   └── (your Node.js code)
└── frontend/
    └── index.html
```

**That's it!** Docker handles everything else. 🐳
