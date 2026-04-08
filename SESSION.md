# Request Interception & Mocking
### A practical approach to owning your API dependencies

---

> **Session goal** — Not a tool walkthrough. A mindset shift in how we handle API dependencies across development, testing and debugging.

---

## Why This Matters

We've all been there. Tests fail not because our code is wrong, but because the API we depend on is down, slow, or returned something unexpected. We wait. We retry. We blame the backend team. Nothing ships.

This session is about taking that dependency back under our control.

---

## The Two-Stage Approach

```
Stage 1 — Intercept & Route     →     control WHERE the request goes
Stage 2 — Mock the Response     →     control WHAT comes back
```

You don't have to do both. Stage 1 alone is powerful. Stage 2 builds on it.

---

## 10 Things to Walk Away With

### 1. You can redirect any API call without touching code
Any outbound request can be intercepted and routed to a different host, version or environment — at the network layer. No config changes. No feature flags. You just tell it where to go.

### 2. Matching precision is what makes mocks trustworthy
A mock matches on URL pattern, HTTP method, query parameters, request headers, and body content (including JSONPath). The more specific the match, the more reliable the test.

### 3. One endpoint, many scenarios
A single API endpoint has multiple behaviours — `200 success`, `404 not found`, `401 unauthorized`, `503 timeout`. Define a mock per scenario. Tests that only cover the happy path aren't really testing anything.

### 4. Frontend and backend can stop waiting for each other
Agree on a contract (OpenAPI spec). Turn it into a mock collection. Frontend builds against it. Backend builds towards it. Both ship in parallel without a single Slack message asking *"is the API ready yet?"*

### 5. You can reproduce any production bug on your laptop
Flaky bugs that only appear with specific API responses can be locked down. Capture the exact response, configure it as a mock, and the bug becomes reproducible by anyone on the team — every single time.

### 6. Edge cases become trivial to test
Rate limits. Timeouts. Malformed responses. Third-party outages. These are nearly impossible to trigger on demand against a real API. Against a mock, they're one config change away.

### 7. Your test suite gets dramatically faster
A mock responds in under `1ms`. A real API averages `200–800ms`, burns quota, generates production logs and sometimes costs money. At scale, this is the difference between a test suite that runs in 2 minutes and one that runs in 20.

### 8. Stop treating mocking as "not real testing"
You're testing your code's behaviour given a specific API contract. That's exactly what an integration test should do. The API team tests their side. Ownership is clean. Coverage is honest.

### 9. Staging environments become optional for most tests
With full control over API responses, most test scenarios don't need a real staging environment at all. Staging becomes the final sanity check, not the primary test surface.

### 10. The workflow compounds
Once your team has a shared mock library, new features start faster. Onboarding is faster. Debugging is faster. The mock collection becomes a living document of every API contract your system depends on.

---

## Session Plan

| Time | What |
|------|------|
| 10 min | Live demo — redirect `prod → staging` without a single line of code change |
| 10 min | Live demo — mock a `404` and verify our error handling actually works |
| 20 min | Open floor — pick one failing test case from the team and fix it together |
| 10 min | Q&A and identify the top 3 use cases we adopt this week |

---

## Where to Start This Week

1. **Pick one flaky test** that fails because of an unstable API dependency
2. **Define the scenario** — what should the API return in the passing case?
3. **Create a mock** for it and run the test against the mock
4. **If it passes** — you've proved the test logic is sound and the API is the variable

That's Stage 1 done. Stage 2 follows naturally.

---

*The goal isn't to mock everything. It's to stop letting things outside your control determine whether your tests pass.*
