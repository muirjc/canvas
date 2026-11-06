; canvas-xl3a.2: the Canvas installer for one person on their own Windows PC. Compiled by build.ps1 over the stage
; folder it prepares (private Python + the API + the web app); build.ps1 passes AppVersion, FileVersion and StageDir.
;
; Installs per user (no administrator rights) to %LOCALAPPDATA%\Programs\Canvas. The data (database, settings,
; logs) lives apart, in %LOCALAPPDATA%\Canvas (canvas_api.desktop), so upgrades keep it and uninstalling asks
; before deleting it. On a first install a wizard page asks for the first admin's email and a temporary password;
; the installer leaves them in first-admin.json in the data folder, and Canvas's first start creates the account
; and deletes the file. A silent install skips this: automation writes first-admin.json ({"email", "password"})
; itself (never put a password on Setup's command line: SetupLogging writes the command line to the log).

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef FileVersion
  #define FileVersion "0.0.0.0"
#endif
#ifndef StageDir
  #define StageDir "out\stage"
#endif

[Setup]
AppId={{7159303F-D7B5-48A0-85E7-6F064B2C7595}
AppName=Canvas
AppVersion={#AppVersion}
AppVerName=Canvas {#AppVersion}
AppPublisher=Canvas
VersionInfoVersion={#FileVersion}
DefaultDirName={autopf}\Canvas
DefaultGroupName=Canvas
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern
OutputBaseFilename=CanvasSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayName=Canvas
SetupLogging=yes
; Canvas is stopped by PrepareToInstall and [UninstallRun] below, not by the Restart Manager.
CloseApplications=no

[InstallDelete]
; An upgrade replaces the program files whole, so nothing from an older version is left behind (the data folder
; is elsewhere).
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\licenses"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Canvas"; Filename: "{app}\python\pythonw.exe"; Parameters: "-m canvas_api.desktop open"; WorkingDir: "{app}"; Comment: "Start Canvas and open it in your browser"
Name: "{group}\Stop Canvas"; Filename: "{app}\python\pythonw.exe"; Parameters: "-m canvas_api.desktop stop"; WorkingDir: "{app}"; Comment: "Stop Canvas running in the background"

[Run]
Filename: "{app}\python\pythonw.exe"; Parameters: "-m canvas_api.desktop open"; WorkingDir: "{app}"; Description: "Start Canvas and open it in your browser"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\python\pythonw.exe"; Parameters: "-m canvas_api.desktop stop"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopCanvas"

[UninstallDelete]
; Python writes __pycache__ folders as it runs.
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app"

[Code]
const
  { The same rules as apps/api-py/src/canvas_api/auth/passwords.py check_password_policy (the account is created
    with it); tests/test_windows_installer.py fails when they drift apart. }
  MinPasswordLength = 12;
  MaxPasswordLength = 256;
  CommonPasswords = '|123456789012|1234567890123|password1234|password12345|passwordpassword|qwertyuiopas|qwerty123456|1q2w3e4r5t6y|iloveyou1234|adminadmin123|administrator|letmein12345|welcome12345|changeme1234|abc123456789|aaaaaaaaaaaa|111111111111|000000000000|canvascanvas|canvas123456|trustno11234|football1234|baseball1234|superman1234|';

var
  AdminPage: TInputQueryWizardPage;

function DataDir: String;
begin
  Result := ExpandConstant('{localappdata}\Canvas');
end;

function HasData: Boolean;
begin
  Result := FileExists(DataDir + '\canvas.db');
end;

function OneCharacterRepeated(S: String): Boolean;
var
  I: Integer;
begin
  Result := Length(S) >= 2;
  for I := 2 to Length(S) do
    if S[I] <> S[1] then
    begin
      Result := False;
      Exit;
    end;
end;

function EmailProblem(Email: String): String;
var
  At: Integer;
begin
  Result := '';
  At := Pos('@', Email);
  if Email = '' then
    Result := 'Enter your email address.'
  else if (At < 2) or (At = Length(Email)) or (Pos(' ', Email) > 0) then
    Result := 'That doesn''t look like an email address.';
end;

function PasswordProblem(Password, Email: String): String;
var
  Lower, LocalPart: String;
begin
  Result := '';
  Lower := AnsiLowercase(Password);
  LocalPart := AnsiLowercase(Copy(Email, 1, Pos('@', Email) - 1));
  if Length(Password) < MinPasswordLength then
    Result := Format('The password must be at least %d characters.', [MinPasswordLength])
  else if Length(Password) > MaxPasswordLength then
    Result := Format('The password can be at most %d characters.', [MaxPasswordLength])
  else if ((Pos('|', Lower) = 0) and (Pos('|' + Lower + '|', CommonPasswords) > 0)) or OneCharacterRepeated(Password) then
    Result := 'That password is too common. Choose something harder to guess.'
  else if (Length(LocalPart) >= 4) and (Pos(LocalPart, Lower) > 0) then
    Result := 'The password can''t contain your email address.';
end;

{ C as four hexadecimal digits (Pascal Script has no IntToHex). }
function Hex4(C: Integer): String;
var
  I: Integer;
begin
  Result := '';
  for I := 1 to 4 do
  begin
    Result := Copy('0123456789abcdef', (C mod 16) + 1, 1) + Result;
    C := C div 16;
  end;
end;

{ A JSON string, ASCII only: SaveStringToFile writes ANSI text, so anything else is written as \u escapes. }
function JsonString(S: String): String;
var
  I, C: Integer;
begin
  Result := '"';
  for I := 1 to Length(S) do
  begin
    C := Ord(S[I]);
    if S[I] = '"' then
      Result := Result + '\"'
    else if S[I] = '\' then
      Result := Result + '\\'
    else if (C < 32) or (C > 126) then
      Result := Result + '\u' + Hex4(C)
    else
      Result := Result + S[I];
  end;
  Result := Result + '"';
end;

procedure InitializeWizard;
begin
  AdminPage := CreateInputQueryPage(wpSelectDir,
    'Your Canvas account',
    'Set up the administrator account you will sign in with.',
    'Canvas keeps its own accounts on this PC. Enter your email address and a temporary password of at least '
    + IntToStr(MinPasswordLength) + ' characters. When you first sign in, Canvas asks you to choose a new one.');
  AdminPage.Add('Email address:', False);
  AdminPage.Add('Temporary password:', True);
  AdminPage.Add('Temporary password again:', True);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { An upgrade keeps the accounts that already exist. A silent install skips the page too: Setup would still
    "click Next" on it, the empty fields would fail the check, and with /SUPPRESSMSGBOXES it would retry forever. }
  Result := (PageID = AdminPage.ID) and (HasData or WizardSilent);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Email, Problem: String;
begin
  Result := True;
  if (CurPageID = AdminPage.ID) and not WizardSilent then
  begin
    Email := Trim(AdminPage.Values[0]);
    Problem := EmailProblem(Email);
    if Problem = '' then
      Problem := PasswordProblem(AdminPage.Values[1], Email);
    if (Problem = '') and (AdminPage.Values[1] <> AdminPage.Values[2]) then
      Problem := 'The two passwords don''t match.';
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Pythonw: String;
  Code: Integer;
begin
  Result := '';
  { An upgrade: stop the running Canvas so its files can be replaced. }
  Pythonw := WizardDirValue + '\python\pythonw.exe';
  if FileExists(Pythonw) then
    Exec(Pythonw, '-m canvas_api.desktop stop', WizardDirValue, SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Email, Password: String;
begin
  if (CurStep <> ssPostInstall) or HasData or WizardSilent then
    Exit;
  Email := Trim(AdminPage.Values[0]);
  Password := AdminPage.Values[1];
  if Email = '' then
    Exit;
  ForceDirectories(DataDir);
  if not SaveStringToFile(DataDir + '\first-admin.json',
      '{"email": ' + JsonString(Email) + ', "password": ' + JsonString(Password) + '}', False) then
    MsgBox('Canvas couldn''t save your account details in ' + DataDir + '.', mbError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(DataDir) and not UninstallSilent then
    if MsgBox('Also delete your Canvas diagrams, accounts and settings?' + #13#10#13#10
        + 'They are in ' + DataDir + '. Keep them if you might install Canvas again.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
end;
