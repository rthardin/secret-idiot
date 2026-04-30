import uuid
from datetime import datetime
from enum import Enum as PyEnum
from sqlalchemy import Column, String, Integer, DateTime, JSON, ForeignKey, Enum, Boolean, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from .database import Base


def gen_uuid():
    return str(uuid.uuid4())


class RoomState(str, PyEnum):
    LOBBY = "LOBBY"
    ROUND_ACTIVE = "ROUND_ACTIVE"
    DEBRIEF_PENDING = "DEBRIEF_PENDING"
    ROUND_SUMMARY = "ROUND_SUMMARY"
    PAUSED = "PAUSED"
    GAME_OVER = "GAME_OVER"


class Role(str, PyEnum):
    AGENT = "AGENT"
    WITNESS = "WITNESS"
    CROWD = "CROWD"


class Difficulty(str, PyEnum):
    EASY = "EASY"
    MEDIUM = "MEDIUM"
    HARD = "HARD"


class ReportType(str, PyEnum):
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    WITNESSED = "WITNESSED"
    MISSED = "MISSED"
    BURN = "BURN"
    NO_SUSPICION = "NO_SUSPICION"


class Room(Base):
    __tablename__ = "rooms"

    id = Column(String, primary_key=True, default=gen_uuid)
    join_code = Column(String(6), unique=True, nullable=False)
    host_id = Column(String, nullable=True)
    current_state = Column(Enum(RoomState), default=RoomState.LOBBY, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    game_over_json = Column(JSON, nullable=True)
    discord_webhook_url = Column(String, nullable=True)

    players = relationship("Player", back_populates="room", foreign_keys="Player.room_id")
    rounds = relationship("Round", back_populates="room")


class Player(Base):
    __tablename__ = "players"

    id = Column(String, primary_key=True, default=gen_uuid)
    room_id = Column(String, ForeignKey("rooms.id"), nullable=False)
    name = Column(String(50), nullable=False)
    session_token = Column(String, nullable=False, default=gen_uuid)
    total_score = Column(Integer, default=0)
    is_host = Column(Boolean, default=False)

    room = relationship("Room", back_populates="players", foreign_keys=[room_id])
    assignments = relationship("Assignment", back_populates="player", foreign_keys="Assignment.player_id")
    reports = relationship("DebriefReport", back_populates="player", foreign_keys="DebriefReport.player_id")


class Round(Base):
    __tablename__ = "rounds"

    id = Column(String, primary_key=True, default=gen_uuid)
    room_id = Column(String, ForeignKey("rooms.id"), nullable=False)
    round_number = Column(Integer, nullable=False)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, default=3600000)
    paused_remaining_ms = Column(Integer, nullable=True)
    results_json = Column(JSON, nullable=True)

    room = relationship("Room", back_populates="rounds")
    assignments = relationship("Assignment", back_populates="round")
    reports = relationship("DebriefReport", back_populates="round")


class Assignment(Base):
    __tablename__ = "assignments"

    id = Column(String, primary_key=True, default=gen_uuid)
    round_id = Column(String, ForeignKey("rounds.id"), nullable=False)
    player_id = Column(String, ForeignKey("players.id"), nullable=False)
    role = Column(Enum(Role), nullable=False)
    mission_id = Column(String, ForeignKey("missions.id"), nullable=True)

    round = relationship("Round", back_populates="assignments")
    player = relationship("Player", back_populates="assignments", foreign_keys=[player_id])
    mission = relationship("Mission")


class Mission(Base):
    __tablename__ = "missions"

    id = Column(String, primary_key=True, default=gen_uuid)
    title = Column(String(100), nullable=True)
    description = Column(Text, nullable=False)
    difficulty = Column(Enum(Difficulty), default=Difficulty.EASY)
    category = Column(String(50), nullable=True)


class MissionVote(Base):
    __tablename__ = "mission_votes"

    id = Column(String, primary_key=True, default=gen_uuid)
    round_id = Column(String, ForeignKey("rounds.id"), nullable=False)
    player_id = Column(String, ForeignKey("players.id"), nullable=False)
    mission_id = Column(String, ForeignKey("missions.id"), nullable=False)
    vote = Column(Boolean, nullable=False)  # True = thumbs up, False = thumbs down

    __table_args__ = (UniqueConstraint("round_id", "player_id"),)


class DebriefReport(Base):
    __tablename__ = "debrief_reports"

    id = Column(String, primary_key=True, default=gen_uuid)
    round_id = Column(String, ForeignKey("rounds.id"), nullable=False)
    player_id = Column(String, ForeignKey("players.id"), nullable=False)
    report_type = Column(Enum(ReportType), nullable=False)
    target_id = Column(String, ForeignKey("players.id"), nullable=True)
    mission_guess = Column(Text, nullable=True)

    vetoed = Column(Boolean, default=False)

    round = relationship("Round", back_populates="reports")
    player = relationship("Player", back_populates="reports", foreign_keys=[player_id])
    target = relationship("Player", foreign_keys=[target_id])
