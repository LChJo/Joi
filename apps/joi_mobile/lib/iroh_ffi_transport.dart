import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

class NativeTransportEvent {
  const NativeTransportEvent({
    required this.type,
    this.frame,
    this.path,
    this.code,
    this.stage,
  });

  factory NativeTransportEvent.fromJson(Map<String, dynamic> value) =>
      NativeTransportEvent(
        type: value['type'] is String ? value['type'] as String : 'error',
        frame: value['frame'],
        path: value['path'] is String ? value['path'] as String : null,
        code: value['code'] is String ? value['code'] as String : null,
        stage: value['stage'] is String ? value['stage'] as String : null,
      );

  final Object? frame;
  final String? path;
  final String type;
  final String? code;
  final String? stage;
}

abstract interface class NativeTransport {
  Stream<NativeTransportEvent> get events;

  Future<void> close();

  Future<void> connect({
    required String connectionId,
    required Map<String, Object?> ticket,
  });

  Future<void> send(Object frame);
}

typedef _StartNative = Uint64 Function(Pointer<Utf8>);
typedef _StartDart = int Function(Pointer<Utf8>);
typedef _SendNative = Bool Function(Uint64, Pointer<Utf8>);
typedef _SendDart = bool Function(int, Pointer<Utf8>);
typedef _PollNative = Pointer<Utf8> Function(Uint64);
typedef _PollDart = Pointer<Utf8> Function(int);
typedef _CloseNative = Void Function(Uint64);
typedef _CloseDart = void Function(int);
typedef _FreeNative = Void Function(Pointer<Utf8>);
typedef _FreeDart = void Function(Pointer<Utf8>);

class IrohFfiTransport implements NativeTransport {
  IrohFfiTransport() : this._(DynamicLibrary.open(_libraryName()));

  IrohFfiTransport._(DynamicLibrary library)
    : _start = library.lookupFunction<_StartNative, _StartDart>(
        'joi_remote_controller_start',
      ),
      _send = library.lookupFunction<_SendNative, _SendDart>(
        'joi_remote_controller_send',
      ),
      _poll = library.lookupFunction<_PollNative, _PollDart>(
        'joi_remote_controller_poll',
      ),
      _close = library.lookupFunction<_CloseNative, _CloseDart>(
        'joi_remote_controller_close',
      ),
      _free = library.lookupFunction<_FreeNative, _FreeDart>(
        'joi_remote_string_free',
      );

  final _events = StreamController<NativeTransportEvent>.broadcast();
  final _CloseDart _close;
  final _FreeDart _free;
  final _PollDart _poll;
  final _SendDart _send;
  final _StartDart _start;
  int _handle = 0;
  Timer? _poller;

  @override
  Stream<NativeTransportEvent> get events => _events.stream;

  @override
  Future<void> connect({
    required String connectionId,
    required Map<String, Object?> ticket,
  }) async {
    await close();
    final config = jsonEncode({
      'connectionId': connectionId,
      'ticket': ticket,
    }).toNativeUtf8();
    try {
      _handle = _start(config);
    } finally {
      malloc.free(config);
    }
    if (_handle == 0) throw StateError('native_remote_start_failed');
    _poller = Timer.periodic(
      const Duration(milliseconds: 80),
      (_) => _drainEvents(),
    );
  }

  @override
  Future<void> send(Object frame) async {
    if (_handle == 0) throw StateError('native_remote_not_connected');
    final value = jsonEncode(frame).toNativeUtf8();
    try {
      if (!_send(_handle, value)) throw StateError('native_remote_send_failed');
    } finally {
      malloc.free(value);
    }
  }

  @override
  Future<void> close() async {
    _poller?.cancel();
    _poller = null;
    if (_handle != 0) _close(_handle);
    _handle = 0;
  }

  void _drainEvents() {
    if (_handle == 0) return;
    while (true) {
      final pointer = _poll(_handle);
      if (pointer == nullptr) return;
      String text;
      try {
        text = pointer.toDartString();
      } finally {
        _free(pointer);
      }
      try {
        final value = jsonDecode(text);
        if (value is! Map<String, dynamic> || value['type'] is! String) {
          throw const FormatException();
        }
        _events.add(NativeTransportEvent.fromJson(value));
      } catch (_) {
        _events.add(
          const NativeTransportEvent(type: 'error', code: 'ffiEventInvalid'),
        );
      }
    }
  }

  static String _libraryName() {
    if (Platform.isAndroid || Platform.isLinux) return 'libjoi_remote.so';
    if (Platform.isWindows) return 'joi_remote.dll';
    if (Platform.isMacOS || Platform.isIOS) return 'libjoi_remote.dylib';
    throw UnsupportedError(
      'Joi native remote is not supported on this platform.',
    );
  }
}
