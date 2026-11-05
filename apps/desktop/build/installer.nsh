; installer.nsh - NSIS script for ARAReader Windows registration & PDF association
; Registers ARAReader with Windows "Default Apps", "Open With", and the PDF icon.
; PDF-only host: no docx/xlsx/pptx/md/diagram associations.

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstall
  DetailPrint "Registering ARAReader default apps capabilities and PDF association..."

  ; 1. Register ARAReader under Windows RegisteredApplications
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "ARAReader" "Software\ARAReader\Capabilities"

  ; 2. Define ARAReader Capabilities (for Windows Settings -> Apps -> Default Apps)
  WriteRegStr SHELL_CONTEXT "Software\ARAReader\Capabilities" "ApplicationName" "ARAReader"
  WriteRegStr SHELL_CONTEXT "Software\ARAReader\Capabilities" "ApplicationDescription" "ARAReader - Smart PDF reader and editor"
  WriteRegStr SHELL_CONTEXT "Software\ARAReader\Capabilities" "ApplicationIcon" "$appExe,0"

  ; File association under Capabilities
  WriteRegStr SHELL_CONTEXT "Software\ARAReader\Capabilities\FileAssociations" ".pdf" "ARAReader.pdf"

  ; 3. Register Applications\ARAReader.exe (used by Windows "Open With" list & Default Apps)
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe" "FriendlyAppName" "ARAReader"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe" "ApplicationCompany" "Adhi Rahmadian"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe\shell\open" "FriendlyAppName" "ARAReader"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe\shell\open\command" "" '"$appExe" "%1"'

  ; SupportedTypes list for ARAReader.exe
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe\SupportedTypes" ".pdf" ""

  ; 4. Ensure the PDF ProgID has the correct DefaultIcon and AppUserModelId
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf" "" "ARAReader PDF"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf" "FriendlyTypeName" "ARAReader PDF"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf" "AppUserModelID" "com.arareader.app"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf\DefaultIcon" "" "$INSTDIR\resources\pdf.ico,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\ARAReader.pdf\shell\open" "FriendlyAppName" "ARAReader"

  ; 5. Register OpenWithList and OpenWithProgids for PDF
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "ARAReader.pdf"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf\OpenWithList\ARAReader.exe" "" ""

  ; 6. Refresh shell notification
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)"
!macroend

!macro customUnInstall
  ; Remove RegisteredApplications entry and Capabilities
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "ARAReader"
  DeleteRegKey SHELL_CONTEXT "Software\ARAReader"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\ARAReader.exe"

  ; Remove the PDF ProgID
  DeleteRegKey SHELL_CONTEXT "Software\Classes\ARAReader.pdf"

  ; Remove OpenWith entries
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "ARAReader.pdf"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\.pdf\OpenWithList\ARAReader.exe"

  ; Refresh shell notification
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)"
!macroend
