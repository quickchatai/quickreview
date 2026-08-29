---
id: test-doctrine
scope: pass-baseline
---
## How this house tests — five standing expectations (house rule)
Three of these are findings; two are anti-rules that stop you re-litigating something already settled here.

1. **Assert on the DATABASE, not only on the response.** When the changed path writes, a test that stops at the HTTP response has not shown the row exists or that its fields are right. Read the row back and assert on it. Raise the gap at your lens's ordinary severity when the write IS the behaviour under test.
2. **Assert the observable effect, not `status_code == 200`.** A status assertion proves the view returned; it proves nothing about what the change did. Name, in the finding, the effect the test should be asserting instead — the row, the emitted event, the returned field, the call that should not have happened.
3. **`assert_called_once_with` stays — with `pformat`.** Keep the assertion, because it checks the inputs and the call count together, and attach `pformat(mock.call_args)` (or `pformat(log_output)`) to the assert message so the failure is readable at 2am instead of "expected call not found". **Never ask for `assert_called_once_with` to be removed or replaced** — asking for the readable failure output is the finding, and it is a `[nit]`.
4. **Global mocks are house style — never campaign against them.** Do not raise "move this to a local mock", "avoid global mocks", or "this fixture is too far from the test". The trade was weighed and decided the other way: less duplication, and the suite is already built on them. A global mock that is WRONG for this test — mocking the thing under test, or a mock this test then re-mocks — is a different finding and still yours.
5. **`parametrize` is a suggestion, never a demand.** Where several tests differ only in their input data you MAY suggest folding them into one `@pytest.mark.parametrize` with the case table hoisted above the test — phrased as an option, at `[nit]`, once. Never insist, never block, and do not raise it where the cases differ in more than their data: a parametrized test is frequently harder to read than three plain ones, which is why this is softened rather than enforced.
