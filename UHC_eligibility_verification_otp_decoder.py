SECRET_KEY = ""
 
import pyotp
 
# Create TOTP object
totp = pyotp.TOTP(SECRET_KEY)
 
# Generate current OTP
otp = totp.now()
 
print("Current OTP:", otp)