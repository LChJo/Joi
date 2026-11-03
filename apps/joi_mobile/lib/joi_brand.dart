import 'i18n.dart';
import 'package:flutter/material.dart';

class JoiBrand extends StatelessWidget {
  const JoiBrand({super.key, this.large = false});

  final bool large;

  @override
  Widget build(BuildContext context) {
    dependOnUiLocale(context);
    final portrait = ClipOval(
      child: Image.asset(
        'assets/joi-portrait.png',
        width: large ? 88 : 32,
        height: large ? 88 : 32,
        filterQuality: FilterQuality.medium,
      ),
    );
    final wordmark = Image.asset(
      'assets/joi-wordmark.png',
      width: large ? 104 : 52,
      height: large ? 66 : 33,
      color: const Color(0xffb8e3c7),
      colorBlendMode: BlendMode.srcIn,
      filterQuality: FilterQuality.medium,
    );
    return Semantics(
      label: 'joi',
      image: true,
      excludeSemantics: true,
      child: large
          ? Column(
              mainAxisSize: MainAxisSize.min,
              children: [portrait, const SizedBox(height: 12), wordmark],
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [portrait, const SizedBox(width: 10), wordmark],
            ),
    );
  }
}
