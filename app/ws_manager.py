import json
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # {room_id: {player_id: WebSocket}}
        self.connections = {}  # {room_id: {player_id: WebSocket}}

    async def connect(self, websocket: WebSocket, room_id: str, player_id: str):
        await websocket.accept()
        if room_id not in self.connections:
            self.connections[room_id] = {}
        self.connections[room_id][player_id] = websocket

    def disconnect(self, room_id: str, player_id: str):
        room = self.connections.get(room_id, {})
        room.pop(player_id, None)

    async def send(self, room_id: str, player_id: str, message: dict):
        ws = self.connections.get(room_id, {}).get(player_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass

    async def broadcast(self, room_id: str, message: dict, exclude=None):
        for pid, ws in list(self.connections.get(room_id, {}).items()):
            if pid == exclude:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass

    def connected_player_ids(self, room_id: str):
        return set(self.connections.get(room_id, {}).keys())
