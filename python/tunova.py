"""Tunova — tiny zero-dependency Python client for the Suno music API (https://api.tunova.ai).

Generation is asynchronous: ``submit()`` returns a ``job_id``; ``generate()`` submits and
polls until the track is delivered. You're billed only when a song actually delivers —
failed renders are auto-refunded.

    from tunova import Tunova

    t = Tunova("sk_live_…")
    job = t.generate("lofi hip hop to code to", model="v5.5")
    if job["status"] == "complete":
        print(job["clips"][0]["audio_url"])
    else:
        print("failed (auto-refunded):", job["error"])

Stdlib only — no pip install needed. Python 3.8+.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

DEFAULT_BASE = "https://api.tunova.ai"
_TERMINAL = ("complete", "failed")


class TunovaError(Exception):
    """An API error. ``code``/``detail`` mirror the JSON error envelope; ``request_id`` is the
    X-Request-Id you can quote to support."""

    def __init__(self, status: int, code: str, detail: str, request_id: Optional[str] = None):
        super().__init__(f"[{status}] {code}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail
        self.request_id = request_id


class Tunova:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE, timeout: float = 30.0):
        if not api_key:
            raise ValueError("api_key is required (your sk_live_… key)")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ---- transport ----
    def _request(self, method: str, path: str, headers: Dict[str, str], data: Optional[bytes]) -> Any:
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                body = json.loads(raw)
            except Exception:
                body = {}
            raise TunovaError(
                e.code,
                body.get("code", "HTTP_ERROR"),
                body.get("detail", raw.decode("utf-8", "replace")[:300]),
                body.get("request_id"),
            ) from None

    def _post(self, path: str, body: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        headers = {"X-API-Key": self.api_key, "Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self._request("POST", path, headers, json.dumps(body).encode())

    def _get(self, path: str) -> Any:
        return self._request("GET", path, {"X-API-Key": self.api_key}, None)

    # ---- API ----
    def submit(
        self,
        prompt: str,
        *,
        custom: bool = False,
        tags: Optional[str] = None,
        title: Optional[str] = None,
        make_instrumental: bool = False,
        model: Optional[str] = None,
        callback_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit a generation job (returns immediately). Response: ``{job_id, status, status_url}``.

        ``custom=True`` switches to lyrics mode (``prompt`` = your lyrics; add ``tags``/``title``).
        ``model`` is e.g. "v5.5". Pass ``callback_url`` for an HMAC-signed webhook on
        completion, or poll ``get_job``. ``idempotency_key`` makes a retried submit return the same
        job (never double-charged)."""
        body: Dict[str, Any] = {"prompt": prompt}
        if custom:
            if tags is not None:
                body["tags"] = tags
            if title is not None:
                body["title"] = title
        if make_instrumental:
            body["make_instrumental"] = True
        if model:
            body["model"] = model
        if callback_url:
            body["callback_url"] = callback_url
        path = "/api/custom_generate" if custom else "/api/generate"
        return self._post(path, body, idempotency_key)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """Fetch a job's current state. Once ``status == "complete"``, ``clips[].audio_url`` is set."""
        return self._get(f"/api/jobs/{job_id}")

    def wait_for(self, job_id: str, *, poll_interval: float = 3.0, timeout: float = 300.0) -> Dict[str, Any]:
        """Poll until the job is terminal ("complete"/"failed") or ``timeout`` seconds elapse."""
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_job(job_id)
            if job.get("status") in _TERMINAL:
                return job
            if time.monotonic() >= deadline:
                raise TunovaError(0, "TIMEOUT", f"job {job_id} not terminal after {timeout}s")
            time.sleep(poll_interval)

    def generate(self, prompt: str, *, poll_interval: float = 3.0, timeout: float = 300.0, **kwargs: Any) -> Dict[str, Any]:
        """``submit`` + ``wait_for``. Returns the terminal job — check ``job["status"]``
        ("complete" or "failed"). All ``submit`` keyword args are forwarded."""
        accepted = self.submit(prompt, **kwargs)
        return self.wait_for(accepted["job_id"], poll_interval=poll_interval, timeout=timeout)

    # ---- webhooks ----
    @staticmethod
    def verify_webhook(
        secret: str,
        timestamp: str,
        body: str,
        signature: str,
        *,
        tolerance: int = 300,
    ) -> bool:
        """Verify a webhook delivery. ``signature`` = the ``X-Webhook-Signature`` header
        ("sha256=<hex>"), ``timestamp`` = ``X-Webhook-Timestamp``, ``body`` = the RAW request body
        string (verify before parsing), ``secret`` = your ``whsec_…`` key. Returns True iff the
        signature matches AND the timestamp is within ``tolerance`` seconds (anti-replay; pass
        ``tolerance=0`` to skip the freshness check)."""
        if tolerance:
            try:
                if abs(time.time() - int(timestamp)) > tolerance:
                    return False
            except (TypeError, ValueError):
                return False
        expected = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
        provided = signature[7:] if signature.startswith("sha256=") else signature
        return hmac.compare_digest(expected, provided)
