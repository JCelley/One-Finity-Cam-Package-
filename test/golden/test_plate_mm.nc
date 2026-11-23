%
(Test plate rev A)
(Onefinity CAM - MASSO post - golden)
(Machine: Onefinity Woodworker X-35)
(Work offset: G54, X0 Y0 front-left of stock, Z0 top of stock)
(T1: 1/4" flat end mill - 6.35 mm flat end mill, 2 fl)
(T4: 60° V-bit - 60° V-bit, 2 fl)
G90 G94 G17 G21 G40 G49 G80
G54
G53 G0 Z0
(Profile on line - T1 1/4" flat end mill)
T1 M6
G43 H1
M3 S18000
G0 X5 Y0
Z5
Z1
G1 Z-3 F500
X45 F1500
G3 X50 Y5 I0 J5
G1 Y25
G3 X45 Y30 I-5 J0
G1 X5
G3 X0 Y25 I0 J-5
G1 Y5
G3 X5 Y0 I5 J0
G1 Z-6 F500
X45 F1500
G3 X50 Y5 I0 J5
G1 Y25
G3 X45 Y30 I-5 J0
G1 X5
G3 X0 Y25 I0 J-5
G1 Y5
G3 X5 Y0 I5 J0
G0 Z5
(Second profile same tool)
S16000
X10 Y10
G1 Z-1 F500
X20 F1500
G0 Z5
G53 G0 Z0
M5
(V line - T4 60° V-bit)
T4 M6
G43 H4
M3 S18000
G0 X10 Y15
Z5
G1 Z-2 F400
X40 F1200
G4 P0.5
G0 Z5
G53 G0 Z0
M5
M30
%
