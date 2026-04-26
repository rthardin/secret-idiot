import asyncio
import json
import random
import string
import uuid
from datetime import datetime, timedelta

from fastapi import Depends, FastAPI, Form, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from sqlalchemy import inspect, text
from .database import Base, SessionLocal, engine, get_db
from .game import assign_roles, calculate_scores, load_missions
from .models import (
    Assignment,
    DebriefReport,
    Mission,
    Player,
    ReportType,
    Role,
    Room,
    RoomState,
    Round,
)
from .push import get_vapid_public_key, send_push_to_players
from .ws_manager import ConnectionManager

import os
_duration_minutes = int(os.getenv("ROUND_DURATION_MINUTES", "60"))
ROUND_DURATION_MS = _duration_minutes * 60 * 1000

app = FastAPI()
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

manager = ConnectionManager()
# {room_id: asyncio.Task}
round_timers = {}  # {room_id: asyncio.Task}


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    db = SessionLocal()
    try:
        load_missions(db)
    finally:
        db.close()


def _migrate_db():
    """Add columns introduced after initial schema creation."""
    inspector = inspect(engine)
    with engine.connect() as conn:
        round_cols = [c["name"] for c in inspector.get_columns("rounds")]
        if "duration_ms" not in round_cols:
            conn.execute(text("ALTER TABLE rounds ADD COLUMN duration_ms INTEGER DEFAULT 3600000"))
        room_cols = [c["name"] for c in inspector.get_columns("rooms")]
        if "game_over_json" not in room_cols:
            conn.execute(text("ALTER TABLE rooms ADD COLUMN game_over_json JSON"))
        conn.commit()


# ---------------------------------------------------------------------------
# Service worker (must be served from root scope for full PWA coverage)
# ---------------------------------------------------------------------------

@app.get("/sw.js")
async def service_worker():
    return FileResponse("app/static/sw.js", media_type="application/javascript")


@app.get("/manifest.json")
async def manifest():
    return FileResponse("app/static/manifest.json", media_type="application/json")


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/create")
async def create_room(host_name: str = Form(...), db: Session = Depends(get_db)):
    join_code = _generate_join_code(db)
    room = Room(id=str(uuid.uuid4()), join_code=join_code)
    db.add(room)
    db.flush()

    host = Player(room_id=room.id, name=host_name.strip()[:30], is_host=True)
    db.add(host)
    db.flush()
    room.host_id = host.id
    db.commit()

    return RedirectResponse(
        f"/room/{join_code}?pid={host.id}&tok={host.session_token}", status_code=303
    )


@app.get("/join/{join_code}", response_class=HTMLResponse)
async def join_page(request: Request, join_code: str, db: Session = Depends(get_db)):
    room = db.query(Room).filter_by(join_code=join_code.upper()).first()
    if not room:
        raise HTTPException(404, "Room not found")
    return templates.TemplateResponse(
        "join.html", {"request": request, "join_code": join_code.upper(), "room": room}
    )


@app.post("/join/{join_code}")
async def join_room(
    join_code: str, player_name: str = Form(...), db: Session = Depends(get_db)
):
    room = db.query(Room).filter_by(join_code=join_code.upper()).first()
    if not room:
        raise HTTPException(404, "Room not found")
    if room.current_state != RoomState.LOBBY:
        raise HTTPException(400, "Game already in progress")

    player = Player(room_id=room.id, name=player_name.strip()[:30])
    db.add(player)
    db.commit()

    await _broadcast_state(room.id, db)

    return RedirectResponse(
        f"/room/{join_code}?pid={player.id}&tok={player.session_token}", status_code=303
    )


@app.get("/room/{join_code}", response_class=HTMLResponse)
async def game_page(
    request: Request,
    join_code: str,
    pid=None,
    tok=None,
    db: Session = Depends(get_db),
):
    room = db.query(Room).filter_by(join_code=join_code.upper()).first()
    if not room:
        raise HTTPException(404, "Room not found")

    player = None
    if pid and tok:
        player = db.query(Player).filter_by(
            id=pid, session_token=tok, room_id=room.id
        ).first()

    if not player:
        return RedirectResponse(f"/join/{join_code.upper()}")

    return templates.TemplateResponse(
        "game.html",
        {
            "request": request,
            "room": room,
            "player": player,
            "join_code": join_code.upper(),
            "vapid_public_key": get_vapid_public_key(),
        },
    )


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/{join_code}/{player_id}/{session_token}")
async def websocket_endpoint(
    websocket: WebSocket, join_code: str, player_id: str, session_token: str
):
    db = SessionLocal()
    try:
        player = db.query(Player).filter_by(
            id=player_id, session_token=session_token
        ).first()
        room = db.query(Room).filter_by(join_code=join_code.upper()).first()

        if not player or not room or player.room_id != room.id:
            await websocket.close(code=4001)
            return

        await manager.connect(websocket, room.id, player_id)

        await _send_state_sync(room.id, player_id, db)

        try:
            while True:
                raw = await websocket.receive_text()
                msg = json.loads(raw)
                # Re-fetch room/player from DB for each message to get fresh state
                db.expire_all()
                room = db.query(Room).filter_by(id=room.id).first()
                player = db.query(Player).filter_by(id=player_id).first()
                await _handle_message(msg, room, player, db)
        except WebSocketDisconnect:
            pass
    finally:
        manager.disconnect(room.id if room else "", player_id)
        db.close()


# ---------------------------------------------------------------------------
# Game flow helpers
# ---------------------------------------------------------------------------

async def _start_round(room: Room, db: Session, duration_ms: int = None):
    if duration_ms is None:
        duration_ms = ROUND_DURATION_MS
    duration_ms = max(5 * 60 * 1000, min(180 * 60 * 1000, duration_ms))

    round_number = db.query(Round).filter_by(room_id=room.id).count() + 1
    rnd = Round(room_id=room.id, round_number=round_number, duration_ms=duration_ms)
    db.add(rnd)
    db.flush()

    assignments = assign_roles(db, rnd.id, room.id)

    rnd.start_time = datetime.utcnow()
    rnd.paused_remaining_ms = None
    room.current_state = RoomState.ROUND_ACTIVE
    db.commit()

    # Build a lookup so witness can be told the agent's identity
    agent_asgn = next((a for a in assignments if a.role == Role.AGENT), None)

    # Send each player their role individually before the general broadcast
    for asgn in assignments:
        mission_text = asgn.mission.description if asgn.mission else None
        payload = {"role": asgn.role.value, "mission_text": mission_text}
        if asgn.role == Role.WITNESS and agent_asgn:
            payload["agent_name"] = agent_asgn.player.name
            payload["agent_mission"] = agent_asgn.mission.description if agent_asgn.mission else None
        await manager.send(room.id, asgn.player_id, {"event": "ROLE_ASSIGNED", "payload": payload})

    await _broadcast_state(room.id, db)

    # Cancel any existing timer and start a new one
    _cancel_timer(room.id)
    task = asyncio.create_task(_round_timer(room.id, duration_ms))
    round_timers[room.id] = task


async def _transition_to_debrief(room_id: str, db: Session):
    room = db.query(Room).filter_by(id=room_id).first()
    if not room or room.current_state not in (RoomState.ROUND_ACTIVE, RoomState.PAUSED):
        return

    _cancel_timer(room_id)
    room.current_state = RoomState.DEBRIEF_PENDING
    db.commit()

    await _broadcast_state(room_id, db)

    players = db.query(Player).filter_by(room_id=room_id).all()
    await send_push_to_players(players, "Round over!", "Open the app to submit your debrief.")


async def _finish_debrief(room_id: str, db: Session):
    room = db.query(Room).filter_by(id=room_id).first()
    if not room or room.current_state != RoomState.DEBRIEF_PENDING:
        return

    rnd = (
        db.query(Round)
        .filter_by(room_id=room_id)
        .order_by(Round.round_number.desc())
        .first()
    )
    if not rnd:
        return

    deltas, outcomes = calculate_scores(db, rnd.id)

    for pid, delta in deltas.items():
        p = db.query(Player).filter_by(id=pid).first()
        if p:
            p.total_score += delta

    agent_asgn = db.query(Assignment).filter_by(round_id=rnd.id, role=Role.AGENT).first()
    witness_asgn = db.query(Assignment).filter_by(round_id=rnd.id, role=Role.WITNESS).first()

    players = db.query(Player).filter_by(room_id=room_id).order_by(Player.total_score.desc()).all()

    results = {
        "round_number": rnd.round_number,
        "agent_name": agent_asgn.player.name if agent_asgn else None,
        "witness_name": witness_asgn.player.name if witness_asgn else None,
        "mission": agent_asgn.mission.description if (agent_asgn and agent_asgn.mission) else None,
        "outcomes": outcomes,
        "score_deltas": [
            {
                "player_id": p.id,
                "name": p.name,
                "delta": deltas.get(p.id, 0),
                "total": p.total_score,
            }
            for p in players
        ],
        "leaderboard": [
            {"name": p.name, "score": p.total_score} for p in players
        ],
    }

    rnd.end_time = datetime.utcnow()
    rnd.results_json = results
    room.current_state = RoomState.ROUND_SUMMARY
    db.commit()

    await manager.broadcast(room_id, {"event": "ROUND_RESULTS", "payload": results})


async def _handle_message(msg: dict, room: Room, player: Player, db: Session):
    action = msg.get("action")
    payload = msg.get("payload", {})

    if action == "START_GAME":
        if not player.is_host or room.current_state != RoomState.LOBBY:
            return
        players = db.query(Player).filter_by(room_id=room.id).all()
        if len(players) < 3:
            await manager.send(
                room.id, player.id,
                {"event": "ERROR", "payload": {"message": "Need at least 3 players to start."}}
            )
            return
        duration_minutes = int(payload.get("duration_minutes", ROUND_DURATION_MS // 60000))
        await _start_round(room, db, duration_ms=duration_minutes * 60 * 1000)

    elif action == "PAUSE_GAME":
        if not player.is_host or room.current_state != RoomState.ROUND_ACTIVE:
            return
        _cancel_timer(room.id)
        rnd = (
            db.query(Round)
            .filter_by(room_id=room.id)
            .order_by(Round.round_number.desc())
            .first()
        )
        if rnd and rnd.start_time:
            elapsed_ms = (datetime.utcnow() - rnd.start_time).total_seconds() * 1000
            round_dur = rnd.duration_ms or ROUND_DURATION_MS
            rnd.paused_remaining_ms = max(0, round_dur - int(elapsed_ms))
        room.current_state = RoomState.PAUSED
        db.commit()
        await _broadcast_state(room.id, db)

    elif action == "RESUME_GAME":
        if not player.is_host or room.current_state != RoomState.PAUSED:
            return
        rnd = (
            db.query(Round)
            .filter_by(room_id=room.id)
            .order_by(Round.round_number.desc())
            .first()
        )
        round_dur = (rnd.duration_ms or ROUND_DURATION_MS) if rnd else ROUND_DURATION_MS
        remaining = rnd.paused_remaining_ms if (rnd and rnd.paused_remaining_ms) else round_dur
        if rnd:
            rnd.start_time = datetime.utcnow() - timedelta(milliseconds=round_dur - remaining)
            rnd.paused_remaining_ms = None
        room.current_state = RoomState.ROUND_ACTIVE
        db.commit()

        task = asyncio.create_task(_round_timer(room.id, remaining))
        round_timers[room.id] = task
        await _broadcast_state(room.id, db)

    elif action == "FORCE_DEBRIEF":
        if not player.is_host or room.current_state not in (RoomState.ROUND_ACTIVE, RoomState.PAUSED):
            return
        await _transition_to_debrief(room.id, db)

    elif action == "SUBMIT_DEBRIEF":
        if room.current_state != RoomState.DEBRIEF_PENDING:
            return
        rnd = (
            db.query(Round)
            .filter_by(room_id=room.id)
            .order_by(Round.round_number.desc())
            .first()
        )
        if not rnd:
            return
        existing = db.query(DebriefReport).filter_by(round_id=rnd.id, player_id=player.id).first()
        if existing:
            return

        report_type = payload.get("report_type")
        try:
            rt = ReportType(report_type)
        except ValueError:
            return

        report = DebriefReport(
            round_id=rnd.id,
            player_id=player.id,
            report_type=rt,
            target_id=payload.get("target_id") if rt == ReportType.BURN else None,
            mission_guess=payload.get("mission_guess") if rt == ReportType.BURN else None,
        )
        db.add(report)
        db.commit()

        all_players = db.query(Player).filter_by(room_id=room.id).all()
        submitted = db.query(DebriefReport).filter_by(round_id=rnd.id).count()
        total = len(all_players)

        await manager.broadcast(
            room.id,
            {
                "event": "DEBRIEF_SUBMITTED",
                "payload": {
                    "player_name": player.name,
                    "submitted_count": submitted,
                    "total_count": total,
                },
            },
        )

        if submitted >= total:
            await _finish_debrief(room.id, db)

    elif action == "FORCE_RESULTS":
        if not player.is_host or room.current_state != RoomState.DEBRIEF_PENDING:
            return
        await _finish_debrief(room.id, db)

    elif action == "NEXT_ROUND":
        if not player.is_host or room.current_state != RoomState.ROUND_SUMMARY:
            return
        duration_minutes = int(payload.get("duration_minutes", ROUND_DURATION_MS // 60000))
        await _start_round(room, db, duration_ms=duration_minutes * 60 * 1000)

    elif action == "RENAME_PLAYER":
        if not player.is_host or room.current_state != RoomState.LOBBY:
            return
        target_id = payload.get("player_id")
        new_name = str(payload.get("new_name", "")).strip()[:30]
        if not new_name or not target_id:
            return
        target = db.query(Player).filter_by(id=target_id, room_id=room.id).first()
        if target:
            target.name = new_name
            db.commit()
            await _broadcast_state(room.id, db)

    elif action == "END_GAME":
        if not player.is_host or room.current_state != RoomState.ROUND_SUMMARY:
            return
        await _end_game(room, db)

    elif action == "SAVE_PUSH_SUB":
        player.push_sub = payload.get("subscription")
        db.commit()


# ---------------------------------------------------------------------------
# State sync builder
# ---------------------------------------------------------------------------

async def _send_state_sync(room_id: str, player_id: str, db: Session):
    room = db.query(Room).filter_by(id=room_id).first()
    player = db.query(Player).filter_by(id=player_id).first()
    if not room or not player:
        return

    all_players = db.query(Player).filter_by(room_id=room_id).all()
    players_payload = [
        {
            "id": p.id,
            "name": p.name,
            "score": p.total_score,
            "is_host": p.is_host,
        }
        for p in all_players
    ]

    payload: dict = {
        "state": room.current_state.value,
        "players": players_payload,
    }

    rnd = (
        db.query(Round)
        .filter_by(room_id=room_id)
        .order_by(Round.round_number.desc())
        .first()
    )

    if room.current_state in (RoomState.ROUND_ACTIVE, RoomState.PAUSED, RoomState.DEBRIEF_PENDING):
        if rnd:
            payload["round_number"] = rnd.round_number
            if room.current_state == RoomState.PAUSED:
                payload["time_remaining_ms"] = rnd.paused_remaining_ms or 0
            elif room.current_state == RoomState.ROUND_ACTIVE and rnd.start_time:
                elapsed_ms = (datetime.utcnow() - rnd.start_time).total_seconds() * 1000
                round_dur = rnd.duration_ms or ROUND_DURATION_MS
                payload["time_remaining_ms"] = max(0, round_dur - int(elapsed_ms))

            asgn = db.query(Assignment).filter_by(
                round_id=rnd.id, player_id=player_id
            ).first()
            if asgn:
                payload["your_role"] = asgn.role.value
                payload["your_mission"] = (
                    asgn.mission.description if asgn.mission else None
                )
                if asgn.role == Role.WITNESS:
                    agent_asgn = db.query(Assignment).filter_by(
                        round_id=rnd.id, role=Role.AGENT
                    ).first()
                    if agent_asgn:
                        payload["agent_name"] = agent_asgn.player.name
                        payload["agent_mission"] = (
                            agent_asgn.mission.description if agent_asgn.mission else None
                        )

            if room.current_state == RoomState.DEBRIEF_PENDING:
                submitted = db.query(DebriefReport).filter_by(round_id=rnd.id).count()
                payload["submitted_count"] = submitted
                payload["total_count"] = len(all_players)

    if room.current_state == RoomState.ROUND_SUMMARY and rnd and rnd.results_json:
        payload["results"] = rnd.results_json

    if room.current_state == RoomState.GAME_OVER and room.game_over_json:
        payload["game_over"] = room.game_over_json

    await manager.send(room_id, player_id, {"event": "ROOM_STATE_SYNC", "payload": payload})


async def _end_game(room: Room, db: Session):
    all_rounds = (
        db.query(Round)
        .filter_by(room_id=room.id)
        .order_by(Round.round_number)
        .all()
    )
    history = []
    for rnd in all_rounds:
        agent_asgn = db.query(Assignment).filter_by(round_id=rnd.id, role=Role.AGENT).first()
        outcomes = rnd.results_json.get("outcomes", []) if rnd.results_json else []
        history.append({
            "round_number": rnd.round_number,
            "agent_name": agent_asgn.player.name if agent_asgn else "?",
            "mission": agent_asgn.mission.description if (agent_asgn and agent_asgn.mission) else "?",
            "outcomes": outcomes,
        })

    players = (
        db.query(Player)
        .filter_by(room_id=room.id)
        .order_by(Player.total_score.desc())
        .all()
    )
    game_over = {
        "leaderboard": [{"name": p.name, "score": p.total_score} for p in players],
        "history": history,
    }
    room.game_over_json = game_over
    room.current_state = RoomState.GAME_OVER
    db.commit()
    await manager.broadcast(room.id, {"event": "GAME_OVER", "payload": game_over})


async def _broadcast_state(room_id: str, db: Session):
    all_players = db.query(Player).filter_by(room_id=room_id).all()
    for p in all_players:
        await _send_state_sync(room_id, p.id, db)


# ---------------------------------------------------------------------------
# Timer
# ---------------------------------------------------------------------------

async def _round_timer(room_id: str, duration_ms: int):
    await asyncio.sleep(duration_ms / 1000)
    db = SessionLocal()
    try:
        await _transition_to_debrief(room_id, db)
    finally:
        db.close()


def _cancel_timer(room_id: str):
    task = round_timers.pop(room_id, None)
    if task:
        task.cancel()


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _generate_join_code(db: Session, length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    for _ in range(20):
        code = "".join(random.choices(chars, k=length))
        if not db.query(Room).filter_by(join_code=code).first():
            return code
    raise RuntimeError("Could not generate unique join code")
