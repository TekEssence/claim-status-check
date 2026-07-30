import base64
import hashlib
import time
from urllib.parse import unquote
 
import pyotp
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
 
 
DATA_VALUE = "CkEKFHIWn%2BV2DVXwawTPyGl%2BZ3%2B6KU8EEg56ZWxpcyBvcGVubWluZCABKAEwAkITMjJjNjYyMTc4MjcyNTc3NzQ1NRACGAEgAA%3D%3D"
def build_payload_class():
    file_desc = descriptor_pb2.FileDescriptorProto()
    file_desc.name = "migration.proto"
    file_desc.package = "google_authenticator"
    file_desc.syntax = "proto3"
 
    # Enums
    enums = {
        "Algorithm": [
            ("ALGORITHM_UNSPECIFIED", 0),
            ("ALGORITHM_SHA1", 1),
            ("ALGORITHM_SHA256", 2),
            ("ALGORITHM_SHA512", 3),
            ("ALGORITHM_MD5", 4),
        ],
        "DigitCount": [
            ("DIGIT_COUNT_UNSPECIFIED", 0),
            ("DIGIT_COUNT_SIX", 1),
            ("DIGIT_COUNT_EIGHT", 2),
        ],
        "OtpType": [
            ("OTP_TYPE_UNSPECIFIED", 0),
            ("OTP_TYPE_HOTP", 1),
            ("OTP_TYPE_TOTP", 2),
        ],
    }
 
    for enum_name, values in enums.items():
        enum = file_desc.enum_type.add()
        enum.name = enum_name
        for name, number in values:
            v = enum.value.add()
            v.name = name
            v.number = number
 
    # OtpParameters message
    otp = file_desc.message_type.add()
    otp.name = "OtpParameters"
 
    fields = [
        ("secret", 1, descriptor_pb2.FieldDescriptorProto.TYPE_BYTES, None),
        ("name", 2, descriptor_pb2.FieldDescriptorProto.TYPE_STRING, None),
        ("issuer", 3, descriptor_pb2.FieldDescriptorProto.TYPE_STRING, None),
        ("algorithm", 4, descriptor_pb2.FieldDescriptorProto.TYPE_ENUM, ".google_authenticator.Algorithm"),
        ("digits", 5, descriptor_pb2.FieldDescriptorProto.TYPE_ENUM, ".google_authenticator.DigitCount"),
        ("type", 6, descriptor_pb2.FieldDescriptorProto.TYPE_ENUM, ".google_authenticator.OtpType"),
        ("counter", 7, descriptor_pb2.FieldDescriptorProto.TYPE_INT64, None),
    ]
 
    for name, number, field_type, type_name in fields:
        f = otp.field.add()
        f.name = name
        f.number = number
        f.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        f.type = field_type
        if type_name:
            f.type_name = type_name
 
    # MigrationPayload message
    payload = file_desc.message_type.add()
    payload.name = "MigrationPayload"
 
    f = payload.field.add()
    f.name = "otp_parameters"
    f.number = 1
    f.label = descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED
    f.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    f.type_name = ".google_authenticator.OtpParameters"
 
    for name, number in [
        ("version", 2),
        ("batch_size", 3),
        ("batch_index", 4),
        ("batch_id", 5),
    ]:
        f = payload.field.add()
        f.name = name
        f.number = number
        f.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        f.type = descriptor_pb2.FieldDescriptorProto.TYPE_INT32
 
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file_desc)
 
    desc = pool.FindMessageTypeByName("google_authenticator.MigrationPayload")
    return message_factory.GetMessageClass(desc)
 
 
def decode_migration_data(data_value):
    decoded = unquote(data_value)
    decoded += "=" * (-len(decoded) % 4)
 
    raw = base64.b64decode(decoded)
 
    Payload = build_payload_class()
    payload = Payload()
    payload.ParseFromString(raw)
    return payload
 
 
def algorithm_digest(algorithm):
    if algorithm == 2:
        return hashlib.sha256
    if algorithm == 3:
        return hashlib.sha512
    if algorithm == 4:
        return hashlib.md5
    return hashlib.sha1
 
 
payload = decode_migration_data(DATA_VALUE)
 
print(f"Total accounts found: {len(payload.otp_parameters)}")
print()
 
for i, account in enumerate(payload.otp_parameters, start=1):
    secret_base32 = base64.b32encode(account.secret).decode("utf-8").replace("=", "")
 
    digits = 8 if account.digits == 2 else 6
    digest = algorithm_digest(account.algorithm)
 
    print("=" * 60)
    print(f"Account #{i}")
    print(f"Issuer : {account.issuer}")
    print(f"Name   : {account.name}")
    print(f"Secret : {secret_base32}")
 
    if account.type != 2:
        print("Type   : HOTP / not TOTP, skipping time-based codes")
        continue
 
    totp = pyotp.TOTP(secret_base32, digits=digits, interval=30, digest=digest)
 
    now = int(time.time())
    current_slot = now - (now % 30)
 
    print()
    print("TOTP codes:")
    for step in range(0, 7):  # current + next 6
        t = current_slot + (step * 30)
        label = "CURRENT" if step == 0 else f"+{step * 30}s"
        print(f"{label:8} | {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t))} | {totp.at(t)}")