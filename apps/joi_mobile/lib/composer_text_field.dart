import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class ComposerTextField extends StatelessWidget {
  const ComposerTextField({
    super.key,
    required this.controller,
    required this.enabled,
    required this.maxLength,
    required this.onChanged,
    required this.onSend,
    required this.decoration,
  });

  final TextEditingController controller;
  final bool enabled;
  final int maxLength;
  final ValueChanged<String> onChanged;
  final VoidCallback? onSend;
  final InputDecoration decoration;

  bool get _isComposing =>
      controller.value.isComposingRangeValid &&
      !controller.value.composing.isCollapsed;

  void _submit() {
    if (enabled && !_isComposing) onSend?.call();
  }

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    final keyboard = HardwareKeyboard.instance;
    if (event is KeyUpEvent ||
        (event.logicalKey != LogicalKeyboardKey.enter &&
            event.logicalKey != LogicalKeyboardKey.numpadEnter) ||
        keyboard.isShiftPressed ||
        keyboard.isAltPressed ||
        _isComposing) {
      return KeyEventResult.ignored;
    }
    if (event is KeyDownEvent) _submit();
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) => Focus(
    canRequestFocus: false,
    onKeyEvent: _handleKey,
    child: TextField(
      controller: controller,
      enabled: enabled,
      minLines: 1,
      maxLines: 5,
      maxLength: maxLength,
      onChanged: onChanged,
      onEditingComplete: _submit,
      textInputAction: TextInputAction.send,
      decoration: decoration,
    ),
  );
}
