import re,sys
p=sys.argv[1]; strict='--strict' in sys.argv; s=open(p).read()
def boxes_only(a,b):
    # identical apart from '[ ]' vs '[x]' on '- [' lines
    norm=lambda t: re.sub(r'^- \[[ x]\] ', '- [ ] ', t, flags=re.M)
    return norm(a)==norm(b)

def resolve(m):
    ours, theirs = m.group(1), m.group(2)
    if strict and not boxes_only(ours, theirs):
        sys.exit(3)
    ticked=set()
    for side in (ours,theirs):
        for mm in re.finditer(r'^- \[x\] (\S+) ', side, re.M): ticked.add(mm.group(1))
    out=[]
    for line in theirs.split('\n'):
        mm=re.match(r'^- \[[ x]\] (\S+) ', line)
        if mm and mm.group(1) in ticked: line='- [x] '+line[6:]
        out.append(line)
    return '\n'.join(out)
s2=re.sub(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', resolve, s, flags=re.S)
open(p,'w').write(s2)
