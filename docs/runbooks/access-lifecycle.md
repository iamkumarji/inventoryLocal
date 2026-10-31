# People joining, moving and leaving

**Joiner:** HR creates the employee (People › Employees); the administrator creates the user (Admin › Users) with a temporary password sent by a separate channel, links it to the employee, and grants roles at the narrowest scope (company → branch → facility → warehouse). The user must enrol MFA and change the password at first sign-in.

**Mover:** remove old grants the same day the new ones start (grants can have end dates). Check Admin › Segregation of duties for conflicts the new combination creates.

**Leaver (same day):** deactivate the user (ends all sessions, blocks sign-in), end-date all grants, before they go, have them delegate pending approvals (Approvals › Delegations); anything left is picked up by the route’s escalation role when overdue. Reassign their open tasks, record the exit in HR. Their past actions stay attributed to them in the audit log. If they held encryption keys or server access, rotate those (see key-rotation).

**Quarterly access review:** each department head reviews Admin › Access grants for their scope; remove anything not needed.
