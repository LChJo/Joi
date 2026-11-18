import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import 'i18n.dart';

class MessageBody extends StatelessWidget {
  const MessageBody(this.text, {super.key, this.scrollTables = false});
  final String text;
  final bool scrollTables;
  @override
  Widget build(BuildContext context) => LocalizedView(
    builder: (context) => MarkdownBody(
      data: text,
      selectable: true,
      styleSheet: scrollTables
          ? MarkdownStyleSheet.fromTheme(
              Theme.of(context),
            ).copyWith(tableColumnWidth: const FixedColumnWidth(144))
          : null,
      imageBuilder: (_, _, _) => Text(tr(Msg.mobileImage)),
      onTapLink: (_, href, _) async {
        final uri = Uri.tryParse(href ?? '');
        if (uri == null || !['https', 'http'].contains(uri.scheme)) return;
        try {
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (_) {
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: LocalizedView(
                  builder: (context) =>
                      Text(tr(Msg.mobileCouldNotOpenTheLinkCopyItToYour)),
                ),
              ),
            );
          }
        }
      },
    ),
  );
}
