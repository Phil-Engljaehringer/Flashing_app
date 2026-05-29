#!/usr/bin/env python3
"""
Virtual COM port bridge via MAVLink SERIAL_CONTROL.

Creates a virtual serial port (PTY) and forwards all traffic bidirectionally
through MAVLink SERIAL_CONTROL messages to a PX4 serialpassthrough module.

Usage:
    python SerialToMavlink.py --connection udp:10.41.1.1:14550 --port tel2 --port-baud 115200
    python SerialToMavlink.py --connection udp:10.41.1.1:14550 --port gps1 --port-baud 9600
    python SerialToMavlink.py --connection udp:10.41.1.1:14550 --port gps2 --port-baud 57600
    python SerialToMavlink.py --connection udp:10.41.1.1:14550 --port esc

Port names map to SERIAL_CONTROL device IDs:
    tel2 -> 1, gps1 -> 2, gps2 -> 3, esc -> 99
"""

import argparse
import os
import pty
import termios
import tty
import threading
import time
from pymavlink import mavutil

# SERIAL_CONTROL_FLAG bitmask values
SERIAL_CONTROL_FLAG_REPLY     = 1
SERIAL_CONTROL_FLAG_RESPOND   = 2
SERIAL_CONTROL_FLAG_EXCLUSIVE = 4
SERIAL_CONTROL_FLAG_BLOCKING  = 8
SERIAL_CONTROL_FLAG_MULTI     = 16

MAX_PAYLOAD = 70

PORT_MAP = {
    'telem2': 1,
    'gps1': 2,
    'gps2': 3,
    'esc':  99,
}


def run_bridge(connection_str, baud, device, port_baud):
    master_fd, slave_fd = pty.openpty()
    slave_path = os.ttyname(slave_fd)

    # Set PTY to raw mode — prevents line discipline from transforming/buffering binary data
    tty.setraw(master_fd)
    tty.setraw(slave_fd)

    print(f"Virtual COM port: {slave_path}")

    mav = mavutil.mavlink_connection(connection_str, baud=baud)
    print(f"Waiting for heartbeat on {connection_str}...")
    mav.wait_heartbeat()
    print(f"Heartbeat received (sysid={mav.target_system}, compid={mav.target_component})")

    # Send an init message with count=0 to trigger FMU-side startForDevice()
    # before any data arrives. baudrate field carries the target UART baud rate.
    print(f"Initializing FMU passthrough: device={device}, port_baud={port_baud}...")
    mav.mav.serial_control_send(
        device=device,
        flags=SERIAL_CONTROL_FLAG_RESPOND | SERIAL_CONTROL_FLAG_EXCLUSIVE,
        timeout=0,
        baudrate=port_baud,
        count=0,
        data=[0] * MAX_PAYLOAD,
    )
    time.sleep(2)  # Give FMU time to spawn the task
    print("Bridge running. Press Ctrl+C to stop.\n")

    stop = threading.Event()

    def pty_to_mavlink():
        """Read from PTY master, forward as SERIAL_CONTROL messages."""
        while not stop.is_set():
            try:
                data = os.read(master_fd, MAX_PAYLOAD)
            except OSError:
                break
            if not data:
                continue
            for i in range(0, len(data), MAX_PAYLOAD):
                chunk = data[i:i + MAX_PAYLOAD]
                payload = list(chunk) + [0] * (MAX_PAYLOAD - len(chunk))
                mav.mav.serial_control_send(
                    device=device,
                    flags=SERIAL_CONTROL_FLAG_RESPOND | SERIAL_CONTROL_FLAG_EXCLUSIVE,
                    timeout=0,
                    baudrate=port_baud,
                    count=len(chunk),
                    data=payload,
                )
                print(f"  PTY -> MAVLink: {len(chunk)} bytes: {chunk.hex(' ')}")

    def mavlink_to_pty():
        """Receive SERIAL_CONTROL FLAG_REPLY messages, write immediately to PTY."""
        while not stop.is_set():
            msg = mav.recv_match(type='SERIAL_CONTROL', blocking=False)
            
            if msg and (msg.flags & SERIAL_CONTROL_FLAG_REPLY):
                reply = bytes(msg.data[:msg.count])
                if reply:
                    os.write(master_fd, reply)
                    print(f"  MAVLink -> PTY: {msg.count} bytes: {reply.hex(' ')}")
            else:
                time.sleep(0.001)

    t1 = threading.Thread(target=pty_to_mavlink, daemon=True)
    t2 = threading.Thread(target=mavlink_to_pty, daemon=True)
    t1.start()
    t2.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down.")
        stop.set()

    os.close(slave_fd)
    os.close(master_fd)
    mav.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Virtual COM port bridge via MAVLink SERIAL_CONTROL')
    parser.add_argument('--connection', default='udp:127.0.0.1:14550',
                        help='MAVLink connection string (default: udp:127.0.0.1:14550)')
    parser.add_argument('--baud', type=int, default=57600,
                        help='Serial baud rate if using serial connection (default: 57600)')
    parser.add_argument('--port', default='gps2',
                        choices=list(PORT_MAP.keys()),
                        help='Target port on the FMU (default: gps2). '
                             'Maps to SERIAL_CONTROL device IDs: tel2=1, gps1=2, gps2=3, esc=99')
    parser.add_argument('--port-baud', type=int, default=115200,
                        help='Baudrate to set on the target UART (default: 115200)')
    args = parser.parse_args()

    device = PORT_MAP[args.port]
    print(f"Port: {args.port} (device ID {device}), UART baud: {args.port_baud}")

    run_bridge(
        connection_str=args.connection,
        baud=args.baud,
        device=device,
        port_baud=args.port_baud,
    )