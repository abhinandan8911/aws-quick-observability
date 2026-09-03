"""
Custom-resource handler for the two Quick permission gaps CloudFormation cannot fill.

`AWS::QuickSight::Topic` and `AWS::QuickSight::Agent` both lack a `permissions`
property, so a CloudFormation-created topic or agent has **no owner** and is invisible
to everyone. This sets them.

SELF-CORRECTING PERMISSION SETS
-------------------------------
Quick rejects any permission set that is not exactly one of its named roles, and the
valid sets are not published anywhere. The service does, however, describe the problem
in two distinguishable ways:

    1. "... do not match a supported <Resource> role. Supported roles: OWNER [a, b], VIEWER [a]."
    2. "Invalid action: quicksight:SomeAction for principal: arn:..."

Both are parsed below. On (1) the advertised OWNER set is adopted wholesale; on (2) the
named action is dropped and the call retried. The effect is that a wrong guess in
config.ts becomes a log line rather than a failed stack. This is also how
`quicksight:InvokeAgent` was found not to be a valid action.
"""

import json
import re
import time
from typing import Any, Callable, Dict, List

import boto3
from botocore.exceptions import ClientError

SUPPORTED_ROLES_RE = re.compile(r"(OWNER|VIEWER|CO_OWNER)\s*\[([^\]]*)\]")
INVALID_ACTION_RE = re.compile(r"Invalid action:\s*(\S+)")


def _client(region: str):
    return boto3.client("quicksight", region_name=region)


def _parse_supported_owner_actions(message: str) -> List[str] | None:
    """Pull the advertised OWNER action list out of a rejection message."""
    best: List[str] | None = None
    for role, body in SUPPORTED_ROLES_RE.findall(message):
        actions = [a.strip() for a in body.split(",") if a.strip()]
        if role == "OWNER" and actions:
            best = actions
    return best


def _parse_invalid_action(message: str) -> str | None:
    match = INVALID_ACTION_RE.search(message)
    return match.group(1).strip().rstrip(".,") if match else None


def grant_with_self_correction(
    label: str,
    grant: Callable[[List[str]], Any],
    actions: List[str],
    max_attempts: int = 8,
) -> List[str]:
    """Call `grant`, adapting `actions` to whatever the service says it will accept."""
    current = list(actions)
    for attempt in range(1, max_attempts + 1):
        try:
            grant(current)
            print(f"{label}: granted {len(current)} action(s): {sorted(current)}")
            return current
        except ClientError as err:
            message = err.response.get("Error", {}).get("Message", "") or str(err)
            code = err.response.get("Error", {}).get("Code", "")
            print(f"{label}: attempt {attempt} rejected ({code}): {message}")

            advertised = _parse_supported_owner_actions(message)
            if advertised and sorted(advertised) != sorted(current):
                print(f"{label}: adopting advertised OWNER set: {sorted(advertised)}")
                current = advertised
                continue

            invalid = _parse_invalid_action(message)
            if invalid and invalid in current:
                print(f"{label}: dropping invalid action {invalid}")
                current = [a for a in current if a != invalid]
                if not current:
                    raise RuntimeError(f"{label}: every action was rejected") from err
                continue

            # Eventual consistency: the resource may not be readable yet.
            if code in ("ResourceNotFoundException", "ThrottlingException", "InternalFailureException"):
                wait = min(2 ** attempt, 20)
                print(f"{label}: retrying in {wait}s")
                time.sleep(wait)
                continue

            raise
    raise RuntimeError(f"{label}: gave up after {max_attempts} attempts")


def _topic_permissions(props: Dict[str, Any]) -> Dict[str, Any]:
    qs = _client(props["Region"])
    account = props["AwsAccountId"]
    topic_id = props["TopicId"]
    principal = props["Principal"]
    actions = list(props["Actions"])

    def grant(current: List[str]):
        # V2 first, because a topic created with the new reader experience prefers it.
        # It fails on CloudFormation-created topics with "This operation is not enabled
        # for this topic. Please use old versions of Topic APIs." — hence the fallback.
        try:
            if hasattr(qs, "update_topic_permissions_v2"):
                return qs.update_topic_permissions_v2(
                    AwsAccountId=account,
                    TopicId=topic_id,
                    GrantPermissions=[{"Principal": principal, "Actions": current}],
                )
        except ClientError as err:
            msg = err.response.get("Error", {}).get("Message", "")
            if "not enabled for this topic" not in msg:
                raise
            print("topic: V2 not enabled for this topic, falling back to V1")
        return qs.update_topic_permissions(
            AwsAccountId=account,
            TopicId=topic_id,
            GrantPermissions=[{"Principal": principal, "Actions": current}],
        )

    granted = grant_with_self_correction(f"topic {topic_id}", grant, actions)
    return {"TopicId": topic_id, "GrantedActions": granted}


def _agent_permissions(props: Dict[str, Any]) -> Dict[str, Any]:
    qs = _client(props["Region"])
    account = props["AwsAccountId"]
    agent_id = props["AgentId"]
    principal = props["Principal"]
    actions = list(props["Actions"])

    if not hasattr(qs, "update_agent_permissions"):
        raise RuntimeError(
            "This boto3 has no update_agent_permissions. The Lambda needs boto3 >= 1.43.19; "
            "check that the pinned layer is attached."
        )

    def grant(current: List[str]):
        return qs.update_agent_permissions(
            AwsAccountId=account,
            AgentId=agent_id,
            GrantPermissions=[{"Principal": principal, "Actions": current}],
        )

    granted = grant_with_self_correction(f"agent {agent_id}", grant, actions)
    return {"AgentId": agent_id, "GrantedActions": granted}


HANDLERS = {
    "TopicPermissions": _topic_permissions,
    "AgentPermissions": _agent_permissions,
}


def on_event(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    print(json.dumps({"RequestType": event.get("RequestType"), "LogicalResourceId": event.get("LogicalResourceId")}))
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    kind = props["Kind"]

    physical_id = event.get("PhysicalResourceId") or f"{kind}-{props.get('TopicId') or props.get('AgentId')}"

    # Delete is a no-op on purpose. The topic and agent are deleted by CloudFormation
    # in the same operation, so there is nothing left to revoke — and answering FAILED
    # on delete would wedge the whole teardown.
    if request_type == "Delete":
        print(f"{kind}: delete is a no-op; the resource itself is being removed")
        return {"PhysicalResourceId": physical_id}

    handler = HANDLERS.get(kind)
    if handler is None:
        raise RuntimeError(f"Unknown Kind '{kind}'. Expected one of {sorted(HANDLERS)}")

    data = handler(props)
    return {"PhysicalResourceId": physical_id, "Data": data}
