# Secret Idiot

A real-time social deduction game for groups. One player is secretly the Agent with a covert mission. Everyone else tries to figure out who it is.

## How it works

- **Agent** — Complete your secret mission visibly enough for your Witness to confirm, but discreetly enough that the Crowd doesn't notice.
- **Witness** — You know who the Agent is and what their mission is, but you're invisible to them. Watch quietly.
- **Crowd** — You have no idea who the Agent is. Stay alert and burn them in the debrief if you catch on.

After the round, everyone submits a debrief report. Crowd members can accuse (burn) someone they think was the Agent. The host can veto a correct burn if it was made for the wrong reason.

### Scoring

| Outcome | Points |
|---|---|
| Perfect Crime | Agent +2, Witness +1 |
| Honorable Effort (Witness missed it) | Agent +1 |
| Sick Burn (correct burn) | Burner +1, Agent −1 |
| False Accusation | Burner −1 |
| Mission Failed | — |

## Tech stack

- **Backend**: FastAPI + SQLAlchemy (SQLite) + WebSockets
- **Frontend**: Vanilla JS, no build step
- **Deployment**: Railway (Nixpacks)

## Running locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open [http://localhost:8000](http://localhost:8000).

## Deployment

The app is configured for Railway. Push to your linked repo and it deploys automatically using the `railway.toml` config.

Environment variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | SQLite path or Postgres URL (defaults to `sqlite:///./secretidiot.db`) |
| `ROUND_DURATION_MINUTES` | Default round duration if not set by host (defaults to `60`) |
## Discord notifications

When creating a room, the host can paste a Discord webhook URL. The webhook will receive an embed notification when each round starts, when results are posted, and when the game ends. The URL is cached in the browser for convenience.
