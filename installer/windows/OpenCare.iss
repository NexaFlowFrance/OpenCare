; =============================================================================
;  OpenCare : Installeur Windows (.exe) : version native (sans Docker)
;  Edite par NexaFlow : https://nexaflow.fr
;  Page du projet : https://nexaflowfrance.github.io/OpenCare/
;
;  L'installeur embarque tout le necessaire : Node.js, PostgreSQL et l'app.
;  Aucune dependance externe, aucune virtualisation, aucun redemarrage.
;  L'utilisateur final ne voit qu'une fenetre graphique avec 3 boutons.
;
;  Compilation : Inno Setup 6.1+  (ISCC.exe OpenCare.iss /DMyAppVersion=1.1.0)
;  Les dossiers app\runtime\node, app\runtime\pgsql, app\server, app\client,
;  app\schema.sql et les assets sont prepares par la CI avant compilation.
; =============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "1.1.0"
#endif

#define MyAppName "OpenCare"
#define MyPublisher "NexaFlow"
#define MyPublisherURL "https://nexaflow.fr"
#define MyProjectURL "https://nexaflowfrance.github.io/OpenCare/"

[Setup]
AppId={{B7E3F1A2-9C44-4F0B-AE11-0F2A1C9D7E55}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
AppPublisherURL={#MyPublisherURL}
AppSupportURL={#MyProjectURL}
AppUpdatesURL={#MyProjectURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\windows
OutputBaseFilename=OpenCare-Setup
; Compression non-solide : l'extraction a l'installation est nettement plus
; rapide (les fichiers sont decompresses independamment) au prix d'une taille
; de setup un peu plus grande.
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern
WizardSizePercent=120
DisableWelcomePage=no
; Affiche le choix de langue (anglais / français) au lancement de l'installeur.
ShowLanguageDialog=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=assets\OpenCare.ico
UninstallDisplayIcon={app}\assets\OpenCare.ico
UninstallDisplayName={#MyAppName}
WizardImageFile=assets\wizard-large.bmp
WizardSmallImageFile=assets\wizard-small.bmp

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french";  MessagesFile: "compiler:Languages\French.isl"

[CustomMessages]
english.DesktopIcon=Create a desktop shortcut
french.DesktopIcon=Creer un raccourci sur le Bureau
english.Shortcuts=Shortcuts:
french.Shortcuts=Raccourcis :
english.OpenControlPanel=Open the OpenCare control panel
french.OpenControlPanel=Ouvrir le panneau de controle OpenCare
english.SiteLink=OpenCare website (NexaFlow)
french.SiteLink=Site OpenCare (NexaFlow)
english.UninstallLink=Uninstall OpenCare
french.UninstallLink=Desinstaller OpenCare
english.OpenNow=Open OpenCare now
french.OpenNow=Ouvrir OpenCare maintenant

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; GroupDescription: "{cm:Shortcuts}"; Flags: checkedonce

[Files]
; Application (client + serveur compiles) et schema de base
Source: "app\OpenCare.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "app\OpenCareControl.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "app\schema.sql";            DestDir: "{app}"; Flags: ignoreversion
Source: "app\engine\*";              DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs
Source: "app\server\*";              DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs
Source: "app\client\*";              DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs
; Runtimes embarques (prepares par la CI)
Source: "app\runtime\*";             DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs
; Visuels (logo OpenCare)
Source: "assets\OpenCare.ico";     DestDir: "{app}\assets"; Flags: ignoreversion
Source: "assets\OpenCare.png";     DestDir: "{app}\assets"; Flags: ignoreversion
Source: "assets\nexaflow.png";       DestDir: "{app}\assets"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
; Raccourci principal -> panneau de controle graphique (logo OpenCare)
Name: "{group}\OpenCare";                 Filename: "{app}\OpenCare.exe"; IconFilename: "{app}\assets\OpenCare.ico"; Comment: "{cm:OpenControlPanel}"
Name: "{group}\{cm:SiteLink}";              Filename: "{#MyProjectURL}"
Name: "{group}\{cm:UninstallLink}";        Filename: "{uninstallexe}"
Name: "{autodesktop}\OpenCare";           Filename: "{app}\OpenCare.exe"; IconFilename: "{app}\assets\OpenCare.ico"; Tasks: desktopicon; Comment: "{cm:OpenControlPanel}"

[Run]
; Ouverture du panneau de controle a la fin de l'installation
Filename: "{app}\OpenCare.exe"; Description: "{cm:OpenNow}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Arret propre des services avant desinstallation
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\engine\stop.ps1"""; Flags: runhidden; RunOnceId: "StopOpenCare"

[Messages]
english.WelcomeLabel2=This wizard will install [name] on your computer.%n%nOpenCare is a self-hosted care coordination app for family caregivers, published by NexaFlow (https://nexaflow.fr).%n%nEverything is included: no extra install, no virtualization, no reboot. Once installed, open OpenCare and click Start.
french.WelcomeLabel2=Cet assistant va installer [name] sur votre ordinateur.%n%nOpenCare est une application auto-hebergee de coordination des aidants familiaux, editee par NexaFlow (https://nexaflow.fr).%n%nTout est inclus : aucune installation supplementaire, aucune virtualisation, aucun redemarrage. Une fois installe, ouvrez OpenCare et cliquez sur Demarrer.
