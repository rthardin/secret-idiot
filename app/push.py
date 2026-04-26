"""
Web Push notification helpers.

To enable push notifications:
1. Generate VAPID keys: python -c "from py_vapid import Vapid; v=Vapid(); v.generate_keys(); v.save_key('vapid_private.pem'); v.save_public_key('vapid_public.pem')"
2. Set VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY env vars (base64-encoded key contents)
3. Set VAPID_CLAIMS_EMAIL env var to your contact email
"""
import os
import json
import logging

logger = logging.getLogger(__name__)

VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY")
VAPID_CLAIMS_EMAIL = os.getenv("VAPID_CLAIMS_EMAIL", "admin@example.com")


def get_vapid_public_key():
    return VAPID_PUBLIC_KEY


async def send_push(subscription: dict, title: str, body: str):
    if not VAPID_PRIVATE_KEY or not subscription:
        return
    try:
        from pywebpush import webpush, WebPushException
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body}),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": f"mailto:{VAPID_CLAIMS_EMAIL}"},
        )
    except Exception as e:
        logger.warning("Push notification failed: %s", e)


async def send_push_to_players(players, title: str, body: str):
    for player in players:
        if player.push_sub:
            await send_push(player.push_sub, title, body)
