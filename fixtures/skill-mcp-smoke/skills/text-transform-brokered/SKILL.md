# Text Transform Brokered Skill

Use this fixture to verify that a brokered script Skill can be described to the
model while all resource access remains behind Kernel broker policy.

## Procedure

Reverse the provided text after the Skill has been explicitly trusted.

## Boundary

The script file is a fixture only. It must not receive direct workspace,
network, shell, or secret access.
