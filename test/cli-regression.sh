#!/usr/bin/env bash
# Compares CLI output of two checkouts on identical fake run folders. No model, no real tmux children.
# Usage: test/cli-regression.sh <old-checkout> <new-checkout>
set -u
OLD=$1 NEW=$2
run_suite() {
	local CLI=$1/subagent.ts
	export PI_CODING_AGENT_DIR=$(mktemp -d)
	local R=$PI_CODING_AGENT_DIR/subagents
	mk() { # handle parent state hasStarted
		mkdir -p $R/$1/inbox
		cat > $R/$1/metadata.json <<J
{"version":1,"handle":"$1","name":"n-$1","parentSessionId":"$2","tmuxSession":"psa-reg-$1","runDir":"$R/$1","sessionFile":"$R/$1/session.jsonl","cwd":"/tmp","provider":"p","model":"m","thinking":"low","state":"$3","hasStarted":$4,"createdAt":"2026-01-01T00:00:0${#1}Z","updatedAt":"x"}
J
		printf '%s\n' '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/tmp"}' \
		  '{"type":"message","id":"e1","parentId":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"answer-'$1'"}],"stopReason":"stop"}}' > $R/$1/session.jsonl
	}
	mk aaa111 parent-A idle true
	mk bbb222 parent-A busy true
	mk ccc333 parent-B idle true
	tmux new-session -d -s psa-reg-aaa111 sleep 60; tmux new-session -d -s psa-reg-bbb222 sleep 60; tmux new-session -d -s psa-reg-ccc333 sleep 60
	c() { local a=("$@"); echo "\$ subagent ${a[*]:2}"; "$@" 2>&1; echo "[exit $?]"; }
	echo "## own session (parent-A)"
	export PI_SESSION_ID=parent-A
	c node $CLI list
	c node $CLI status aaa111
	c node $CLI wait aaa111 --timeout 2
	c node $CLI wait bbb222 --timeout 1
	c node $CLI rename aaa111 renamed
	c node $CLI send aaa111 hello there
	c node $CLI send bbb222 --follow-up later
	c node $CLI status zzz999
	c node $CLI bogus
	c node $CLI spawn
	echo "## plain terminal"
	unset PI_SESSION_ID
	c node $CLI status ccc333
	c node $CLI wait ccc333 --timeout 2
	echo "## child"
	PI_SUBAGENT_RUN_DIR=/x PI_SESSION_ID=child-1 c node $CLI status ccc333
	PI_SUBAGENT_RUN_DIR=/x c node $CLI spawn --prompt x
	echo "## expected change: another session's handle"
	export PI_SESSION_ID=parent-A
	c node $CLI status ccc333
	c node $CLI send ccc333 hi
	echo "## stop"
	export PI_SESSION_ID=parent-A
	c node $CLI stop aaa111
	c node $CLI list
	for h in aaa111 bbb222 ccc333; do tmux kill-session -t psa-reg-$h 2>/dev/null; done
	rm -rf $PI_CODING_AGENT_DIR
}
run_suite $OLD > /tmp/psa-reg-old.txt
run_suite $NEW > /tmp/psa-reg-new.txt
diff -u /tmp/psa-reg-old.txt /tmp/psa-reg-new.txt && echo "IDENTICAL"
