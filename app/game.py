import json
import random
from pathlib import Path
from sqlalchemy.orm import Session
from .models import Assignment, DebriefReport, Mission, Player, ReportType, Role


MISSIONS_FILE = Path(__file__).parent.parent / "missions.json"


def load_missions(db: Session):
    if db.query(Mission).count() > 0:
        return
    data = json.loads(MISSIONS_FILE.read_text())
    for item in data:
        db.add(Mission(
            description=item["description"],
            difficulty=item.get("difficulty", "EASY"),
            category=item.get("category", "general"),
        ))
    db.commit()


def assign_roles(db: Session, round_id: str, room_id: str) -> list[Assignment]:
    players = db.query(Player).filter_by(room_id=room_id).all()
    if len(players) < 3:
        raise ValueError("Need at least 3 players to start")

    shuffled = players[:]
    random.shuffle(shuffled)

    missions = db.query(Mission).all()
    mission = random.choice(missions)

    assignments = [
        Assignment(round_id=round_id, player_id=shuffled[0].id, role=Role.AGENT, mission_id=mission.id),
        Assignment(round_id=round_id, player_id=shuffled[1].id, role=Role.WITNESS),
    ]
    for player in shuffled[2:]:
        assignments.append(Assignment(round_id=round_id, player_id=player.id, role=Role.CROWD))

    db.add_all(assignments)
    db.commit()

    # Re-query to populate relationships
    return db.query(Assignment).filter_by(round_id=round_id).all()


def calculate_scores(db: Session, round_id: str) -> tuple[dict, list, list]:
    """
    Returns (score_deltas, outcomes, burns).
    score_deltas: {player_id: int}
    outcomes: list of dicts for outcome chips
    burns: list of dicts with full burn details (including vetoed state)
    """
    reports = db.query(DebriefReport).filter_by(round_id=round_id).all()
    assignments = db.query(Assignment).filter_by(round_id=round_id).all()

    agent_asgn = next((a for a in assignments if a.role == Role.AGENT), None)
    witness_asgn = next((a for a in assignments if a.role == Role.WITNESS), None)

    if not agent_asgn:
        return {}, [{"type": "NO_AGENT"}], []

    agent_id = agent_asgn.player_id
    witness_id = witness_asgn.player_id if witness_asgn else None

    agent_report = next((r for r in reports if r.player_id == agent_id), None)
    witness_report = next((r for r in reports if r.player_id == witness_id), None) if witness_id else None
    burn_reports = [r for r in reports if r.report_type == ReportType.BURN]

    agent_succeeded = agent_report and agent_report.report_type == ReportType.SUCCESS
    witness_saw = witness_report and witness_report.report_type == ReportType.WITNESSED

    deltas: dict[str, int] = {}
    outcomes: list[dict] = []
    burns: list[dict] = []
    correct_burns: list[DebriefReport] = []

    for burn in burn_reports:
        accuser = db.query(Player).filter_by(id=burn.player_id).first()
        target = db.query(Player).filter_by(id=burn.target_id).first()
        is_correct = burn.target_id == agent_id
        vetoed = bool(burn.vetoed)

        burns.append({
            "id": burn.id,
            "accuser_name": accuser.name if accuser else "?",
            "accuser_id": burn.player_id,
            "target_name": target.name if target else "?",
            "target_id": burn.target_id,
            "correct": is_correct,
            "vetoed": vetoed,
            "mission_guess": burn.mission_guess,
        })

        outcome_base = {
            "burn_id": burn.id,
            "accuser_name": accuser.name if accuser else "?",
            "vetoed": vetoed,
        }

        if vetoed:
            outcome_type = "SLOPPY_AGENT" if is_correct else "FALSE_ACCUSATION"
            if not is_correct:
                outcome_base["target_name"] = target.name if target else "?"
            outcomes.append({"type": outcome_type, **outcome_base})
            continue

        if is_correct:
            deltas[burn.player_id] = deltas.get(burn.player_id, 0) + 1
            deltas[agent_id] = deltas.get(agent_id, 0) - 1
            correct_burns.append(burn)
            outcomes.append({"type": "SLOPPY_AGENT", **outcome_base})
        else:
            deltas[burn.player_id] = deltas.get(burn.player_id, 0) - 1
            outcome_base["target_name"] = target.name if target else "?"
            outcomes.append({"type": "FALSE_ACCUSATION", **outcome_base})

    if not correct_burns:
        if agent_succeeded and witness_saw:
            deltas[agent_id] = deltas.get(agent_id, 0) + 2
            if witness_id:
                deltas[witness_id] = deltas.get(witness_id, 0) + 2
            outcomes.append({"type": "PERFECT_CRIME"})
        elif agent_succeeded:
            deltas[agent_id] = deltas.get(agent_id, 0) + 1
            outcomes.append({"type": "HONORABLE_EFFORT"})
        else:
            outcomes.append({"type": "MISSION_FAILED"})

    return deltas, outcomes, burns
