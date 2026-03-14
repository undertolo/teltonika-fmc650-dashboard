#!/usr/bin/env python3
"""
Servidor TCP Python para recibir datos de Teltonika FMC650
Guarda datos en MySQL para ser consumidos por backend Node.js
"""

import socket
import struct
import logging
import sys
from datetime import datetime
from typing import Dict, List, Tuple, Optional
import threading
import os

# Importar módulo de base de datos
try:
    import mysql.connector
    from mysql.connector import Error
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False
    print("⚠️  mysql-connector-python no está instalado")

# Configuración de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)
logging.getLogger('mysql').setLevel(logging.WARNING)
logging.getLogger('mysql.connector').setLevel(logging.WARNING)


class DatabaseManager:
    """Gestor de base de datos MySQL"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.connection = None
        self.connect()
    
    def connect(self):
        """Conectar a MySQL"""
        try:
            self.connection = mysql.connector.connect(
                host=self.config.get('host', 'localhost'),
                port=self.config.get('port', 3306),
                database=self.config.get('database', 'teltonika'),
                user=self.config.get('user', 'root'),
                password=self.config.get('password', ''),
                autocommit=True
            )
            
            if self.connection.is_connected():
                logger.info(f"✅ Conectado a MySQL: {self.config.get('database')}")
        
        except Error as e:
            logger.error(f"❌ Error conectando a MySQL: {e}")
            self.connection = None
    
    def get_or_create_device(self, imei: str) -> Optional[int]:
        """Obtiene o crea un dispositivo"""
        try:
            cursor = self.connection.cursor()
            
            cursor.execute("SELECT id FROM devices WHERE imei = %s", (imei,))
            result = cursor.fetchone()
            
            if result:
                device_id = result[0]
                cursor.execute(
                    "UPDATE devices SET last_seen = %s WHERE id = %s",
                    (datetime.now(), device_id)
                )
            else:
                now = datetime.now()
                cursor.execute(
                    "INSERT INTO devices (imei, first_seen, last_seen) VALUES (%s, %s, %s)",
                    (imei, now, now)
                )
                device_id = cursor.lastrowid
                logger.info(f"📱 Nuevo dispositivo: IMEI {imei} (ID: {device_id})")
            
            cursor.close()
            return device_id
        
        except Error as e:
            logger.error(f"❌ Error con dispositivo: {e}")
            return None
    
    def save_gps_data(self, imei: str, parsed_data: Dict, client_address: str) -> bool:
        """Guarda datos GPS en MySQL"""
        try:
            device_id = self.get_or_create_device(imei)
            if not device_id:
                return False
            
            cursor = self.connection.cursor()
            received_at = datetime.now()
            
            records = parsed_data.get('records', [])
            saved_count = 0
            
            for record in records:
                gps = record.get('gps', {})
                
                cursor.execute("""
                    INSERT INTO gps_data (
                        device_id, timestamp, timestamp_ms, priority,
                        latitude, longitude, altitude, angle, satellites, speed,
                        received_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    device_id,
                    record.get('timestamp'),
                    record.get('timestamp_ms'),
                    record.get('priority'),
                    gps.get('latitude'),
                    gps.get('longitude'),
                    gps.get('altitude'),
                    gps.get('angle'),
                    gps.get('satellites'),
                    gps.get('speed'),
                    received_at
                ))
                
                gps_record_id = cursor.lastrowid
                
                io_data = record.get('io', {})
                elements = io_data.get('elements', {})
                event_id = io_data.get('event_id')
                
                for name, elem in elements.items():
                    cursor.execute("""
                        INSERT INTO io_data (
                            gps_record_id, event_id, io_id, io_name, io_value, io_size
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                    """, (
                        gps_record_id,
                        event_id,
                        elem.get('id'),
                        name,
                        elem.get('value'),
                        elem.get('size')
                    ))
                
                saved_count += 1
            
            cursor.execute(
                "UPDATE devices SET total_records = total_records + %s WHERE id = %s",
                (saved_count, device_id)
            )
            
            cursor.close()
            
            logger.info(f"💾 Guardados {saved_count} registros de IMEI {imei}")
            return True
        
        except Error as e:
            logger.error(f"❌ Error guardando datos: {e}")
            return False
    
    def close(self):
        """Cerrar conexión"""
        if self.connection and self.connection.is_connected():
            self.connection.close()
            logger.info("🔌 Conexión a MySQL cerrada")


class TeltonikaParser:
    """Parser para protocolo Codec 8/8 Extended de Teltonika"""
    
    IO_ELEMENTS = {
        1: "Digital Input 1", 2: "Digital Input 2", 3: "Digital Input 3", 4: "Digital Input 4",
        9: "Analog Input 1", 10: "Analog Input 2", 11: "GSM Signal", 16: "Total Odometer",
        21: "GSM Cell ID", 24: "Speed", 66: "External Voltage", 67: "Battery Voltage",
        68: "Battery Current", 69: "GNSS Status", 80: "Data Mode", 113: "Battery Level",
        181: "GNSS PDOP", 182: "GNSS HDOP", 199: "Trip Odometer", 200: "Sleep Mode",
        205: "GSM Cell ID", 240: "Movement", 241: "Active GSM Operator",
    }
    
    @staticmethod
    def parse_imei(data: bytes) -> Optional[str]:
        try:
            if len(data) < 2:
                return None
            imei_length = struct.unpack(">H", data[:2])[0]
            if len(data) < 2 + imei_length:
                return None
            imei = data[2:2+imei_length].decode('ascii')
            logger.info(f"IMEI recibido: {imei}")
            return imei
        except Exception as e:
            logger.error(f"Error parseando IMEI: {e}")
            return None
    
    @staticmethod
    def parse_avl_data(data: bytes) -> Optional[Dict]:
        try:
            offset = 0
            preamble = struct.unpack(">I", data[offset:offset+4])[0]
            offset += 4
            data_length = struct.unpack(">I", data[offset:offset+4])[0]
            offset += 4
            codec_id = data[offset]
            offset += 1
            
            if codec_id != 0x08 and codec_id != 0x8E:
                logger.warning(f"Codec ID desconocido: {hex(codec_id)}")
            
            num_records = data[offset]
            offset += 1
            
            logger.info(f"Codec: {hex(codec_id)}, Registros: {num_records}")
            
            records = []
            for i in range(num_records):
                record, offset = TeltonikaParser.parse_avl_record(data, offset, codec_id)
                if record:
                    records.append(record)
            
            return {
                'codec_id': hex(codec_id),
                'num_records': num_records,
                'records': records
            }
        except Exception as e:
            logger.error(f"Error parseando AVL data: {e}")
            return None
    
    @staticmethod
    def parse_avl_record(data: bytes, offset: int, codec_id: int) -> Tuple[Optional[Dict], int]:
        try:
            record = {}
            timestamp_ms = struct.unpack(">Q", data[offset:offset+8])[0]
            offset += 8
            timestamp = datetime.fromtimestamp(timestamp_ms / 1000.0)
            record['timestamp'] = timestamp.isoformat()
            record['timestamp_ms'] = timestamp_ms
            
            priority = data[offset]
            offset += 1
            record['priority'] = priority
            
            gps_data, offset = TeltonikaParser.parse_gps_element(data, offset)
            record['gps'] = gps_data
            
            io_data, offset = TeltonikaParser.parse_io_element(data, offset, codec_id)
            record['io'] = io_data
            
            return record, offset
        except Exception as e:
            logger.error(f"Error parseando AVL record: {e}")
            return None, offset
    
    @staticmethod
    def parse_gps_element(data: bytes, offset: int) -> Tuple[Dict, int]:
        gps = {}
        longitude = struct.unpack(">i", data[offset:offset+4])[0] / 10000000.0
        offset += 4
        gps['longitude'] = longitude
        
        latitude = struct.unpack(">i", data[offset:offset+4])[0] / 10000000.0
        offset += 4
        gps['latitude'] = latitude
        
        altitude = struct.unpack(">H", data[offset:offset+2])[0]
        offset += 2
        gps['altitude'] = altitude
        
        angle = struct.unpack(">H", data[offset:offset+2])[0]
        offset += 2
        gps['angle'] = angle
        
        satellites = data[offset]
        offset += 1
        gps['satellites'] = satellites
        
        speed = struct.unpack(">H", data[offset:offset+2])[0]
        offset += 2
        gps['speed'] = speed
        
        return gps, offset
    
    @staticmethod
    def parse_io_element(data: bytes, offset: int, codec_id: int) -> Tuple[Dict, int]:
        io = {}
        
        if codec_id == 0x8E:
            event_id = struct.unpack(">H", data[offset:offset+2])[0]
            offset += 2
        else:
            event_id = data[offset]
            offset += 1
        io['event_id'] = event_id
        
        if codec_id == 0x8E:
            total_io = struct.unpack(">H", data[offset:offset+2])[0]
            offset += 2
        else:
            total_io = data[offset]
            offset += 1
        io['total_elements'] = total_io
        io['elements'] = {}
        
        for size in [1, 2, 4, 8]:
            offset = TeltonikaParser.parse_io_by_size(data, offset, size, io['elements'], codec_id)
        
        return io, offset
    
    @staticmethod
    def parse_io_by_size(data: bytes, offset: int, size: int, elements: Dict, codec_id: int) -> int:
        try:
            if codec_id == 0x8E:
                count = struct.unpack(">H", data[offset:offset+2])[0]
                offset += 2
            else:
                count = data[offset]
                offset += 1
            
            for _ in range(count):
                if codec_id == 0x8E:
                    io_id = struct.unpack(">H", data[offset:offset+2])[0]
                    offset += 2
                else:
                    io_id = data[offset]
                    offset += 1
                
                if size == 1:
                    value = data[offset]
                    offset += 1
                elif size == 2:
                    value = struct.unpack(">H", data[offset:offset+2])[0]
                    offset += 2
                elif size == 4:
                    value = struct.unpack(">I", data[offset:offset+4])[0]
                    offset += 4
                elif size == 8:
                    value = struct.unpack(">Q", data[offset:offset+8])[0]
                    offset += 8
                
                element_name = TeltonikaParser.IO_ELEMENTS.get(io_id, f"IO_{io_id}")
                elements[element_name] = {'id': io_id, 'value': value, 'size': size}
            
            return offset
        except Exception as e:
            logger.error(f"Error parseando IO size {size}: {e}")
            return offset


class TeltonikaServer:
    """Servidor TCP para dispositivos Teltonika"""
    
    def __init__(self, host: str = '0.0.0.0', port: int = 8000, db_config: Dict = None):
        self.host = host
        self.port = port
        self.server_socket = None
        self.running = False
        self.parser = TeltonikaParser()
        self.db = None
        
        if DB_AVAILABLE and db_config:
            try:
                self.db = DatabaseManager(db_config)
            except Exception as e:
                logger.error(f"❌ Error inicializando BD: {e}")
    
    def start(self):
        try:
            self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server_socket.bind((self.host, self.port))
            self.server_socket.listen(5)
            self.running = True
            
            logger.info(f"🚀 Servidor TCP iniciado en {self.host}:{self.port}")
            logger.info("📡 Esperando conexiones de FMC650...")
            
            while self.running:
                try:
                    client_socket, client_address = self.server_socket.accept()
                    logger.info(f"📱 Nueva conexión desde {client_address}")
                    
                    client_thread = threading.Thread(
                        target=self.handle_client,
                        args=(client_socket, client_address)
                    )
                    client_thread.daemon = True
                    client_thread.start()
                
                except Exception as e:
                    if self.running:
                        logger.error(f"Error aceptando conexión: {e}")
        
        except Exception as e:
            logger.error(f"Error iniciando servidor: {e}")
        finally:
            self.stop()
    
    def handle_client(self, client_socket: socket.socket, client_address: tuple):
        imei = None
        try:
            imei_data = client_socket.recv(1024)
            if not imei_data:
                return
            
            imei = self.parser.parse_imei(imei_data)
            
            if imei:
                client_socket.send(b'\x01')
                logger.info(f"✅ IMEI aceptado: {imei}")
            else:
                client_socket.send(b'\x00')
                return
            
            while self.running:
                data = client_socket.recv(4096)
                if not data:
                    break
                
                parsed_data = self.parser.parse_avl_data(data)
                
                if parsed_data and self.db:
                    client_addr_str = f"{client_address[0]}:{client_address[1]}"
                    self.db.save_gps_data(imei, parsed_data, client_addr_str)
                    
                    num_records = parsed_data['num_records']
                    ack = struct.pack(">I", num_records)
                    client_socket.send(ack)
                    logger.info(f"📤 ACK enviado: {num_records} registros")
        
        except Exception as e:
            logger.error(f"Error con cliente {client_address}: {e}")
        finally:
            client_socket.close()
            logger.info(f"🔌 Conexión cerrada: {client_address} (IMEI: {imei})")
    
    def stop(self):
        logger.info("🛑 Deteniendo servidor...")
        self.running = False
        if self.server_socket:
            try:
                self.server_socket.close()
            except:
                pass
        if self.db:
            try:
                self.db.close()
            except:
                pass
        logger.info("✅ Servidor detenido")


if __name__ == "__main__":
    # Cargar variables de entorno desde .env
    from dotenv import load_dotenv
    load_dotenv()

    HOST = '0.0.0.0'
    PORT = 8000

    DB_CONFIG = {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', 3306)),
        'database': os.getenv('DB_NAME', 'teltonika'),
        'user': os.getenv('DB_USER', 'teltonika_user'),
        'password': os.getenv('DB_PASSWORD', 'teltonika_pass')
    }
    
    logger.info("="*60)
    logger.info("SERVIDOR TELTONIKA FMC650 (Python)")
    logger.info("="*60)
    logger.info(f"TCP: {HOST}:{PORT}")
    logger.info(f"BD: {DB_CONFIG['database']} @ {DB_CONFIG['host']}")
    logger.info("="*60)
    
    if not DB_AVAILABLE:
        logger.error("❌ mysql-connector-python no instalado")
        import sys
        sys.exit(1)
    
    server = TeltonikaServer(host=HOST, port=PORT, db_config=DB_CONFIG)
    
    try:
        server.start()
    except KeyboardInterrupt:
        logger.info("\n⚠️  Interrupción del usuario (Ctrl+C)")
        server.stop()
    except Exception as e:
        logger.error(f"Error fatal: {e}")
        server.stop()
