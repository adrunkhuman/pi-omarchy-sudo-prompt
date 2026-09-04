import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
  id: root

  property bool pending: false
  property string requestId: ""
  property string commandText: ""
  property string reasonText: ""
  property string impactText: ""
  property string cwdText: ""
  property double deadlineMs: 0
  property double executionTimeoutMs: 610000
  property double nowMs: Date.now()
  property var decisions: ({})

  readonly property int secondsLeft: Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
  readonly property color accent: Color.polkit.accent
  readonly property color background: Color.polkit.background
  readonly property color foreground: Color.polkit.text
  readonly property color borderColor: Color.polkit.border
  readonly property color scrim: Color.polkit.scrim
  readonly property int cornerRadius: Style.cornerRadius
  readonly property int contentMargin: Style.spacing.panelPadding
  readonly property var borderSpec: Border.surfaceSpec("polkit", "border", borderColor, Math.max(1, Style.space(2)), "border-alpha")

  function response(id, state, reason, feedback) {
    return JSON.stringify({ id: id, state: state, reason: reason || "", feedback: feedback || "" })
  }

  function decide(state, reason, feedback) {
    if (!pending || !requestId) return
    decisions[requestId] = { state: state, reason: reason || "user", feedback: feedback || "" }
    pending = false
    deadlineMs = Date.now() + (state === "allow" ? executionTimeoutMs + 30000 : 30000)
  }

  function begin(payloadJson) {
    if (requestId) return JSON.stringify({ accepted: false, state: "busy" })

    var payload
    try {
      payload = JSON.parse(payloadJson)
    } catch (error) {
      return JSON.stringify({ accepted: false, state: "invalid-json" })
    }

    if (!payload.id || !payload.command || !payload.reason || !payload.impact) {
      return JSON.stringify({ accepted: false, state: "invalid-request" })
    }

    requestId = String(payload.id)
    commandText = String(payload.command)
    reasonText = String(payload.reason)
    impactText = String(payload.impact)
    cwdText = String(payload.cwd || "")
    nowMs = Date.now()
    deadlineMs = nowMs + Math.max(5000, Number(payload.timeoutMs) || 120000)
    executionTimeoutMs = Math.max(10000, Number(payload.executionTimeoutMs) || 610000)
    decisions[requestId] = { state: "pending", reason: "", feedback: "" }
    denyFeedback.text = ""
    pending = true
    commandView.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    return JSON.stringify({ accepted: true, id: requestId, state: "pending" })
  }

  Timer {
    interval: 250
    running: root.requestId !== ""
    repeat: true
    onTriggered: {
      root.nowMs = Date.now()
      if (root.nowMs < root.deadlineMs) return
      if (root.pending) root.decide("deny", "timeout", "")
      else {
        delete root.decisions[root.requestId]
        root.requestId = ""
      }
    }
  }

  IpcHandler {
    target: "io.github.adrunkhuman.pi-privileged-exec"

    function version(): string { return "0.2.0" }

    function request(payloadJson: string): string {
      return root.begin(payloadJson)
    }

    function state(id: string): string {
      var decision = root.decisions[id]
      if (!decision) return root.response(id, "deny", "unknown-request", "")
      return root.response(id, decision.state, decision.reason, decision.feedback)
    }

    function dismiss(id: string): string {
      if (root.pending && root.requestId === id) root.decide("deny", "dismissed", "")
      delete root.decisions[id]
      if (root.requestId === id) root.requestId = ""
      return "ok"
    }
  }

  PanelWindow {
    id: panel
    visible: root.pending
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "pi-privilege-approval"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: keyCatcher.forceActiveFocus()
    }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true

      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          root.decide("deny", "escape", denyFeedback.text.trim())
          event.accepted = true
        } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                   && (event.modifiers & Qt.ControlModifier)) {
          root.decide("allow", "user")
          event.accepted = true
        }
      }
    }

    BorderSurface {
      id: card
      width: Math.min(Style.space(760), panel.width - Style.gapsOut * 2)
      height: Math.min(
        panel.height - Style.gapsOut * 2,
        Math.max(
          Style.space(300),
          root.contentMargin * 2 + Style.space(148)
            + Math.min(details.implicitHeight, Style.space(300))
        )
      )
      anchors.centerIn: parent
      radius: root.cornerRadius
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea {
        anchors.fill: parent
        onClicked: keyCatcher.forceActiveFocus()
      }

      Item {
        id: content
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset

        Row {
          id: header
          anchors.top: parent.top
          width: parent.width
          height: Style.space(38)
          spacing: Style.space(12)

          Text {
            text: "\uf023"
            color: root.accent
            font.family: Style.fontFamily
            font.pixelSize: Style.font.iconLarge
            width: Style.space(30)
            height: parent.height
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
          }

          Column {
            width: parent.width - Style.space(42)
            spacing: Style.space(2)

            Text {
              text: "PI PRIVILEGE REQUEST"
              color: root.foreground
              font.family: Style.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            Text {
              width: parent.width
              text: "Review the command before Omarchy asks you to authenticate"
              textFormat: Text.PlainText
              color: Util.alpha(root.foreground, 0.62)
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
          }
        }

        Rectangle {
          id: divider
          anchors.top: header.bottom
          anchors.topMargin: Style.space(10)
          width: parent.width
          height: 1
          color: Util.alpha(root.borderColor, 0.5)
        }

        Flickable {
          id: commandView
          anchors.top: divider.bottom
          anchors.topMargin: Style.space(12)
          anchors.right: parent.right
          anchors.bottom: expiry.top
          anchors.bottomMargin: Style.space(10)
          anchors.left: parent.left
          contentWidth: width
          contentHeight: details.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds

          Column {
            id: details
            width: commandView.width
            spacing: Style.space(8)

            Text {
              text: "REASON"
              color: root.accent
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            Text {
              width: parent.width
              text: root.reasonText
              textFormat: Text.PlainText
              color: root.foreground
              font.family: Style.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.Wrap
            }

            Text {
              text: "IMPACT"
              color: root.accent
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            Text {
              width: parent.width
              text: root.impactText
              textFormat: Text.PlainText
              color: Util.alpha(root.foreground, 0.76)
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }

            Text {
              text: "COMMAND"
              color: root.accent
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            Rectangle {
              width: parent.width
              height: commandDisplay.implicitHeight + Style.space(20)
              radius: Math.max(2, root.cornerRadius / 2)
              color: Util.alpha(root.foreground, 0.055)
              border.width: 1
              border.color: Util.alpha(root.borderColor, 0.45)

              Text {
                id: commandDisplay
                anchors.fill: parent
                anchors.margins: Style.space(10)
                text: root.commandText
                textFormat: Text.PlainText
                color: root.foreground
                font.family: Style.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WrapAnywhere
              }
            }

            Text {
              width: parent.width
              text: root.cwdText ? "cwd  " + root.cwdText : ""
              textFormat: Text.PlainText
              color: Util.alpha(root.foreground, 0.5)
              font.family: Style.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideMiddle
            }
          }
        }

        Text {
          id: expiry
          anchors.right: parent.right
          anchors.bottom: buttons.top
          anchors.bottomMargin: Style.space(8)
          text: "expires in " + root.secondsLeft + "s"
          color: Util.alpha(root.foreground, 0.5)
          font.family: Style.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Row {
          id: buttons
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          height: Style.space(42)
          spacing: Style.space(12)

          Rectangle {
            width: (parent.width - parent.spacing) / 2
            height: parent.height
            radius: root.cornerRadius
            color: Util.alpha(root.foreground, 0.07)
            border.width: 1
            border.color: Util.alpha(root.foreground, 0.2)

            Item {
              id: denyAction
              anchors.top: parent.top
              anchors.bottom: parent.bottom
              anchors.left: parent.left
              width: Style.space(116)

              Text {
                anchors.centerIn: parent
                text: "Deny  [Esc]"
                color: root.foreground
                font.family: Style.fontFamily
                font.pixelSize: Style.font.body
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.decide("deny", "user", denyFeedback.text.trim())
              }
            }

            Rectangle {
              anchors.top: parent.top
              anchors.topMargin: 1
              anchors.right: parent.right
              anchors.rightMargin: 1
              anchors.bottom: parent.bottom
              anchors.bottomMargin: 1
              anchors.left: denyAction.right
              radius: Math.max(1, root.cornerRadius - 1)
              color: Util.alpha(root.foreground, 0.035)

              Rectangle {
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                width: 1
                color: Util.alpha(root.foreground, 0.2)
              }

              TextInput {
                id: denyFeedback
                anchors.fill: parent
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                verticalAlignment: TextInput.AlignVCenter
                maximumLength: 160
                clip: true
                color: root.foreground
                selectionColor: Util.alpha(root.accent, 0.45)
                selectedTextColor: root.foreground
                font.family: Style.fontFamily
                font.pixelSize: Style.font.bodySmall

                Keys.priority: Keys.BeforeItem
                Keys.onPressed: function(event) {
                  if (event.key === Qt.Key_Escape) {
                    root.decide("deny", "escape", denyFeedback.text.trim())
                    event.accepted = true
                  } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                             && (event.modifiers & Qt.ControlModifier)) {
                    root.decide("allow", "user", "")
                    event.accepted = true
                  } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    root.decide("deny", "user", denyFeedback.text.trim())
                    event.accepted = true
                  }
                }
              }

              Text {
                anchors.fill: denyFeedback
                verticalAlignment: Text.AlignVCenter
                text: "why? (optional)"
                color: Util.alpha(root.foreground, 0.36)
                font.family: Style.fontFamily
                font.pixelSize: Style.font.bodySmall
                visible: denyFeedback.text.length === 0
              }
            }
          }

          Rectangle {
            width: (parent.width - parent.spacing) / 2
            height: parent.height
            radius: root.cornerRadius
            color: root.accent

            Text {
              anchors.centerIn: parent
              text: "Allow  [Ctrl+Enter]"
              color: root.background
              font.family: Style.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: root.decide("allow", "user")
            }
          }
        }
      }
    }
  }
}
