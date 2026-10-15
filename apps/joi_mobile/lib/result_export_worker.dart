import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:image/image.dart' as img;

import 'result_document.dart';

img.Image decodeResultRaster(Uint8List pixels, int width, int height) {
  if (width <= 0 ||
      height <= 0 ||
      width > 8192 ||
      height > 8192 ||
      pixels.lengthInBytes != width * height * 4) {
    throw StateError('export_raster_invalid');
  }
  return img.Image.fromBytes(
    width: width,
    height: height,
    bytes: pixels.buffer,
    bytesOffset: pixels.offsetInBytes,
    numChannels: 4,
    order: img.ChannelOrder.rgba,
  );
}

class ResultExportWorker {
  ResultExportWorker._(
    this._isolate,
    this._commands,
    this._errors,
    this._exits,
    this._failed,
    this._subscriptions,
  );
  final Isolate _isolate;
  final SendPort _commands;
  final ReceivePort _errors;
  final ReceivePort _exits;
  final Completer<bool> _failed;
  final List<StreamSubscription<dynamic>> _subscriptions;

  static Future<ResultExportWorker> start(String directory, String name) async {
    final ready = ReceivePort();
    final errors = ReceivePort();
    final exits = ReceivePort();
    final failed = Completer<bool>();
    void fail(dynamic _) {
      if (!failed.isCompleted) failed.complete(false);
    }

    final subscriptions = [errors.listen(fail), exits.listen(fail)];
    Isolate? isolate;
    try {
      isolate = await Isolate.spawn(
        _runExportWorker,
        (ready.sendPort, directory, name),
        onError: errors.sendPort,
        onExit: exits.sendPort,
      );
      final commands = await Future.any<dynamic>([ready.first, failed.future]);
      if (commands is! SendPort) throw StateError('export_worker_failed');
      return ResultExportWorker._(
        isolate,
        commands,
        errors,
        exits,
        failed,
        subscriptions,
      );
    } catch (_) {
      isolate?.kill(priority: Isolate.immediate);
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
      errors.close();
      exits.close();
      rethrow;
    } finally {
      ready.close();
    }
  }

  Future<Map<String, dynamic>> request(
    String command,
    Map<String, dynamic> data,
  ) async {
    final reply = ReceivePort();
    try {
      _commands.send((reply.sendPort, command, data));
      final response = await Future.any<dynamic>([reply.first, _failed.future]);
      if (response is! Map || response['error'] == true) {
        throw StateError('export_worker_failed');
      }
      return Map<String, dynamic>.from(response);
    } finally {
      reply.close();
    }
  }

  Future<void> dispose() async {
    if (!_failed.isCompleted) _failed.complete(false);
    _isolate.kill(priority: Isolate.immediate);
    for (final subscription in _subscriptions) {
      await subscription.cancel();
    }
    _errors.close();
    _exits.close();
  }
}

void _runExportWorker((SendPort, String, String) configuration) async {
  final (ready, directory, name) = configuration;
  final commands = ReceivePort();
  ready.send(commands.sendPort);
  img.Image? canvas;
  var used = 0;
  var index = 0;
  final paths = <String>[];
  Future<void> flush() async {
    if (canvas == null) return;
    final cropped = img.copyCrop(
      canvas!,
      x: 0,
      y: 0,
      width: 1080,
      height: used,
    );
    final path = '$directory/$name-${(++index).toString().padLeft(3, '0')}.png';
    await File(path).writeAsBytes(img.encodePng(cropped));
    paths.add(path);
    canvas = null;
    used = 0;
  }

  await for (final message in commands) {
    final (reply, command, data) =
        message as (SendPort, String, Map<String, dynamic>);
    try {
      if (command == 'render') {
        final document = await renderResultDocument(
          data['body'] as String,
          (data['fonts'] as List)
              .cast<Uint8List>()
              .map(ByteData.sublistView)
              .toList(),
        );
        reply.send({'bytes': document.bytes, 'pageCount': document.pageCount});
      } else if (command == 'page') {
        final pixels = (data['pixels'] as TransferableTypedData)
            .materialize()
            .asUint8List();
        final decoded = decodeResultRaster(
          pixels,
          data['width'] as int,
          data['height'] as int,
        );
        final height = (decoded.height * 1080 / decoded.width).round();
        if (height < 1 || height > 8192) {
          throw StateError('export_raster_invalid');
        }
        final raster = img.copyResize(decoded, width: 1080, height: height);
        if (used + raster.height > 8192) await flush();
        canvas ??= img.fill(
          img.Image(width: 1080, height: 8192, numChannels: 3),
          color: img.ColorRgb8(255, 255, 255),
        );
        img.compositeImage(canvas!, raster, dstY: used);
        used += raster.height;
        reply.send({'ok': true});
      } else if (command == 'finish') {
        await flush();
        reply.send({'paths': paths});
      } else {
        reply.send({'error': true});
      }
    } catch (_) {
      // Only stable stage failures cross back to the UI isolate.
      reply.send({'error': true});
    }
  }
}
