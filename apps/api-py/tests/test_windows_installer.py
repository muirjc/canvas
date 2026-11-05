"""The Windows installer's wizard checks the first admin's password with a copy of the password policy (Inno Setup's
Pascal can't call Python), so that a password the account creation would refuse is refused on the wizard page,
not after install, where it would leave the PC without an account. These tests keep the copy equal to the rules."""

import re
from pathlib import Path

from canvas_api.auth import passwords

INSTALLER_SCRIPT = Path(__file__).resolve().parents[3] / "packaging" / "windows" / "canvas.iss"


def _constant(name: str) -> str:
    match = re.search(rf"^\s*{name}\s*=\s*(.+?);\s*$", INSTALLER_SCRIPT.read_text(encoding="utf-8"), re.MULTILINE)
    assert match, f"{name} is missing from canvas.iss"
    return match.group(1)


def test_the_installer_has_the_same_length_limits() -> None:
    assert int(_constant("MinPasswordLength")) == passwords.MIN_PASSWORD_LENGTH
    assert int(_constant("MaxPasswordLength")) == passwords.MAX_PASSWORD_LENGTH


def test_the_installer_refuses_the_same_common_passwords() -> None:
    listed = _constant("CommonPasswords")
    assert listed.startswith("'|") and listed.endswith("|'")
    assert set(listed.strip("'|").split("|")) == set(passwords._COMMON_PASSWORDS)


def test_the_installer_checks_the_other_rules() -> None:
    script = INSTALLER_SCRIPT.read_text(encoding="utf-8")
    # One character repeated, and the email's local part (4+ characters) inside the password.
    assert passwords._ONE_CHARACTER_REPEATED.pattern == r"(.)\1+"
    assert "OneCharacterRepeated(Password)" in script
    assert "(Length(LocalPart) >= 4) and (Pos(LocalPart, Lower) > 0)" in script
